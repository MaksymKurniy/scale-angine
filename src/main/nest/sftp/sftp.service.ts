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
// Keepalive is critical for long-running deployments. NAT/firewalls silently
// drop idle SSH tunnels after a few minutes; without keepalive we never
// notice because ssh2 doesn't proactively check the socket. With these
// settings we send a keepalive probe every 20 s and treat the connection
// as dead after 3 missed replies (~60 s), which triggers our auto-reconnect.
const KEEPALIVE_INTERVAL_MS = 20_000;
const KEEPALIVE_COUNT_MAX = 3;
// Any single SFTP operation that takes longer than this is treated as a
// zombie call (typically a dead socket). We reject with a timeout error so
// the tick can unwind, mark the connection dead and reconnect.
const OP_TIMEOUT_MS = 30_000;

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
   *
   * @param force  When true, unconditionally tear down any existing client
   *               and rebuild. Use this from user-initiated Start actions —
   *               a zombie client (thinks it's connected but socket is dead)
   *               can otherwise short-circuit the reconnect.
   */
  async connect(uri: string, passwordOverride?: string, force: boolean = false): Promise<void> {
    const cacheKey = `${uri} ${passwordOverride ?? ''}`;
    this.wantedUri = uri;
    this.wantedPassword = passwordOverride ?? '';
    this.cancelReconnect();

    if (!force && this.connected && this.connectedUri === cacheKey && this.client) return;

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
        // ssh2 transport keepalive: sends SSH2_MSG_GLOBAL_REQUEST every
        // KEEPALIVE_INTERVAL_MS and errors out after KEEPALIVE_COUNT_MAX
        // missed replies. Without this, a dead NAT tunnel looks alive to us.
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
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

  /**
   * Aggressive teardown. `ssh2.end()` awaits the underlying stream's 'close'
   * event, which can (rarely) hang on a half-open TCP socket. We give it 5s
   * and then null the reference regardless — the OS will GC the socket, and
   * pretending to still hold the reference just leads to zombie state.
   */
  private async closeClient(): Promise<void> {
    if (!this.client) {
      this.connected = false;
      return;
    }
    const c = this.client;
    // Detach right away so any concurrent handleDrop / event handlers can't
    // touch this instance's fields via the stale reference.
    this.client = null;
    this.connected = false;
    try {
      await Promise.race([
        c.end(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5_000)),
      ]);
    } catch (err) {
      this.logger.warn('SftpService', `Force-closing stale client (${(err as Error).message})`);
      // As a last resort try the underlying stream, if we can reach it.
      try {
        // ssh2-sftp-client exposes the inner ssh2 Client as `.client` in some
        // versions and via `_client` in others. Both are best-effort.
        const inner = (c as any).client || (c as any)._client;
        if (inner && typeof inner.end === 'function') inner.end();
        if (inner && typeof inner.destroy === 'function') inner.destroy();
      } catch { /* ignore */ }
    }
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

  /**
   * Race a promise against a timer. On timeout we also *forcefully* mark the
   * connection dead, which triggers our auto-reconnect flow. This is the
   * safety net against silently-dead sockets — the underlying ssh2 promise
   * may never resolve, but we unwind the tick and start reconnecting.
   */
  private withTimeout<T>(op: string, promise: Promise<T>, ms: number = OP_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        this.logger.warn('SftpService', `Operation timed out after ${ms} ms: ${op}`);
        // Force-close the stale client. handleDrop() will schedule reconnect.
        this.handleDrop(`timeout on ${op}`);
        reject(new Error(`SFTP operation timed out: ${op}`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!)) as Promise<T>;
  }

  async ensureDir(remotePath: string): Promise<void> {
    const c = this.ensure();
    const exists = await this.withTimeout(`exists ${remotePath}`, c.exists(remotePath));
    if (!exists) {
      await this.withTimeout(`mkdir ${remotePath}`, c.mkdir(remotePath, true));
    } else if (exists !== 'd') {
      throw new Error(`Remote path exists but is not a directory: ${remotePath}`);
    }
  }

  async listXmlFiles(remoteDir: string): Promise<{ name: string; size: number; modifyTime: number }[]> {
    const c = this.ensure();
    const exists = await this.withTimeout(`exists ${remoteDir}`, c.exists(remoteDir));
    if (!exists) return [];
    const items = await this.withTimeout(`list ${remoteDir}`, c.list(remoteDir));
    return items
      .filter((it) => it.type === '-' && it.name.toLowerCase().endsWith('.xml'))
      .map((it) => ({ name: it.name, size: it.size, modifyTime: it.modifyTime }));
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const c = this.ensure();
    // Uploads can legitimately take longer than a list; give them 2× the
    // default. A 10 KB XML that takes 60 s to upload means the tunnel is
    // hopelessly slow and reconnecting is the right call anyway.
    await this.withTimeout(`put ${remotePath}`, c.put(localPath, remotePath), OP_TIMEOUT_MS * 2);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const c = this.ensure();
    await this.withTimeout(`get ${remotePath}`, c.fastGet(remotePath, localPath), OP_TIMEOUT_MS * 2);
  }

  async moveRemote(src: string, dst: string): Promise<void> {
    const c = this.ensure();
    await this.withTimeout(`rename ${src} -> ${dst}`, c.rename(src, dst));
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    const c = this.ensure();
    const r = await this.withTimeout(`exists ${remotePath}`, c.exists(remotePath));
    return Boolean(r);
  }
}
