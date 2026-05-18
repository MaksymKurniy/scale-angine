import { Injectable } from '@nestjs/common';
import SftpClient from 'ssh2-sftp-client';
import { AppLogger } from '../logger.service';

export interface SftpConnectOptions {
  host: string;
  port: number;
  username: string;
  password: string;
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const READY_TIMEOUT_MS = 15_000;

/**
 * Thin wrapper around ssh2-sftp-client.
 *
 * Holds a single live connection. The watcher services share this instance so
 * we don't open a new SSH session for every poll tick.
 *
 * If the connection drops (network blip, server restart, idle timeout…) the
 * service remembers the wanted URI/password and transparently reconnects with
 * exponential backoff. `ensureConnected()` can be called by the watcher tick
 * to wait for the next available connection without re-issuing a manual Start.
 */
@Injectable()
export class SftpService {
  private client: SftpClient | null = null;
  private connected = false;
  private connectedUri = '';

  // "Wanted" connection state — set by connect(), cleared by disconnect().
  // While these are set we will keep trying to reconnect after drops.
  private wantedUri = '';
  private wantedPassword = '';

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connecting = false;

  constructor(private readonly logger: AppLogger) {}

  /**
   * Parse sftp://user:pass@host:port into connection options.
   *
   * Hand-rolled because Node's built-in `URL` choked on raw special characters
   * inside SFTP passwords (slash, plus, colon, at-sign...) and SFTP-To-Go style
   * credentials almost always contain at least one of those. Strategy:
   *   1. strip the `sftp://` scheme
   *   2. split at the LAST `@` -- anything before it is creds, after is host
   *      (slashes inside creds must NOT be treated as path separators, so we
   *      do the @-split before any path-stripping)
   *   3. on the host part, drop any trailing `/path`
   *   4. inside the creds, split at the FIRST `:` -- that gives user:password
   *   5. try percent-decoding each piece, but fall back to the raw value if
   *      that would mangle it (the user almost certainly pasted raw)
   */
  static parseUri(uri: string): SftpConnectOptions {
    if (!uri || !uri.trim()) {
      throw new Error('SFTP URI is empty');
    }
    const trimmed = uri.trim();
    const SCHEME = 'sftp://';
    if (!trimmed.toLowerCase().startsWith(SCHEME)) {
      throw new Error(`SFTP URI must start with sftp:// — got "${trimmed.slice(0, 16)}…"`);
    }

    const rest = trimmed.slice(SCHEME.length);

    let credsPart = '';
    let hostPart = rest;
    const atIdx = rest.lastIndexOf('@');
    if (atIdx >= 0) {
      credsPart = rest.slice(0, atIdx);
      hostPart = rest.slice(atIdx + 1);
    }

    // Drop any trailing "/path" on the host part only -- slashes inside the
    // password (which lives in credsPart) must be preserved verbatim.
    const slashIdx = hostPart.indexOf('/');
    if (slashIdx >= 0) hostPart = hostPart.slice(0, slashIdx);

    // host[:port] -- IPv6 in brackets not supported; SFTP-To-Go doesn't use it.
    let host: string;
    let port = 22;
    const colon = hostPart.lastIndexOf(':');
    if (colon >= 0) {
      host = hostPart.slice(0, colon);
      const portStr = hostPart.slice(colon + 1);
      const parsedPort = Number(portStr);
      if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
        throw new Error(`SFTP URI has invalid port: "${portStr}"`);
      }
      port = parsedPort;
    } else {
      host = hostPart;
    }
    if (!host) throw new Error('SFTP URI is missing host');

    let username = '';
    let password = '';
    if (credsPart) {
      const sep = credsPart.indexOf(':');
      if (sep >= 0) {
        username = credsPart.slice(0, sep);
        password = credsPart.slice(sep + 1);
      } else {
        username = credsPart;
      }
    }

    return {
      host,
      port,
      username: SftpService.maybeDecode(username),
      password: SftpService.maybeDecode(password),
    };
  }

  /**
   * Percent-decode a string, but only if it actually contains a `%XX` triplet.
   * Otherwise return it as-is -- most users paste raw passwords like
   * `aBc+12/dE=` and we must not touch those.
   */
  private static maybeDecode(s: string): string {
    if (!s) return '';
    if (!/%[0-9a-fA-F]{2}/.test(s)) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Open (or reopen) the SFTP connection. Remembers the URI+password so that
   * subsequent drops trigger automatic reconnection.
   */
  async connect(uri: string, passwordOverride?: string): Promise<void> {
    const cacheKey = `${uri} ${passwordOverride ?? ''}`;
    this.wantedUri = uri;
    this.wantedPassword = passwordOverride ?? '';
    this.cancelReconnect();

    if (this.connected && this.connectedUri === cacheKey && this.client) return;

    await this.closeClient();
    await this.openClient(cacheKey);
  }

  /** Permanently stop reconnecting and close the session. */
  async disconnect(): Promise<void> {
    this.wantedUri = '';
    this.wantedPassword = '';
    this.cancelReconnect();
    await this.closeClient();
    this.connectedUri = '';
  }

  /**
   * Block until the connection is live again (or throw if we were never
   * asked to connect). Watchers call this at the top of each tick so a
   * transient blip just causes them to wait one cycle.
   */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;
    if (!this.wantedUri) {
      throw new Error('SFTP is not connected and no connection was requested');
    }
    if (this.connecting) {
      await this.waitFor(() => this.connected || !this.wantedUri, 20_000);
      if (this.connected) return;
    }
    const cacheKey = `${this.wantedUri} ${this.wantedPassword}`;
    await this.openClient(cacheKey);
  }

  private async openClient(cacheKey: string): Promise<void> {
    if (this.connecting) {
      await this.waitFor(() => !this.connecting, 20_000);
      if (this.connected) return;
    }
    this.connecting = true;
    try {
      const opts = SftpService.parseUri(this.wantedUri);
      if (this.wantedPassword) opts.password = this.wantedPassword;

      const pwSource = this.wantedPassword ? 'separate field' : 'URI';
      const pwHint = opts.password
        ? `${opts.password.length} chars from ${pwSource}, ends with "${opts.password.slice(-2)}"`
        : '(empty)';
      const suffix = this.reconnectAttempt > 0 ? ` (reconnect #${this.reconnectAttempt})` : '';
      this.logger.info(
        'SftpService',
        `Connecting to ${opts.host}:${opts.port} as ${opts.username || '(anonymous)'} [password: ${pwHint}]${suffix}...`,
      );

      const client = new SftpClient();
      await client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        readyTimeout: READY_TIMEOUT_MS,
      });

      this.client = client;
      this.connected = true;
      this.connectedUri = cacheKey;
      this.reconnectAttempt = 0;
      this.logger.success('SftpService', 'SFTP connected');

      client.on('end', () => this.handleDrop('connection ended'));
      client.on('close', () => this.handleDrop('connection closed'));
      client.on('error', (err) => this.handleDrop(`error: ${err.message}`));
    } catch (err) {
      this.logger.error('SftpService', `Connect failed: ${(err as Error).message}`);
      this.connected = false;
      this.client = null;
      // Only schedule a reconnect if the user still wants us connected.
      if (this.wantedUri) this.scheduleReconnect();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private handleDrop(reason: string): void {
    if (!this.connected && !this.client) return; // already torn down
    this.connected = false;
    if (this.client) {
      try { void this.client.end(); } catch { /* ignore */ }
    }
    this.client = null;
    if (this.wantedUri) {
      this.logger.warn('SftpService', `SFTP ${reason} -- will reconnect`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // already scheduled
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.logger.info('SftpService', `Reconnect in ${delay} ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.wantedUri) return; // user pressed Stop in the meantime
      try {
        const cacheKey = `${this.wantedUri} ${this.wantedPassword}`;
        await this.openClient(cacheKey);
      } catch {
        // openClient already scheduled the next attempt
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private async closeClient(): Promise<void> {
    if (this.client) {
      try { await this.client.end(); } catch { /* ignore */ }
    }
    this.client = null;
    this.connected = false;
  }

  private async waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private ensure(): SftpClient {
    if (!this.client || !this.connected) {
      throw new Error('SFTP is not connected');
    }
    return this.client;
  }

  async ensureDir(remotePath: string): Promise<void> {
    const c = this.ensure();
    const exists = await c.exists(remotePath);
    if (!exists) {
      await c.mkdir(remotePath, true);
    } else if (exists !== 'd') {
      throw new Error(`Remote path exists but is not a directory: ${remotePath}`);
    }
  }

  async listXmlFiles(remoteDir: string): Promise<{ name: string; size: number; modifyTime: number }[]> {
    const c = this.ensure();
    const exists = await c.exists(remoteDir);
    if (!exists) return [];
    const items = await c.list(remoteDir);
    return items
      .filter((it) => it.type === '-' && it.name.toLowerCase().endsWith('.xml'))
      .map((it) => ({ name: it.name, size: it.size, modifyTime: it.modifyTime }));
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const c = this.ensure();
    await c.put(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const c = this.ensure();
    await c.fastGet(remotePath, localPath);
  }

  async moveRemote(src: string, dst: string): Promise<void> {
    const c = this.ensure();
    await c.rename(src, dst);
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    const c = this.ensure();
    const r = await c.exists(remotePath);
    return Boolean(r);
  }
}
