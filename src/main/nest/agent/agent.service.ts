import { Injectable } from '@nestjs/common';
import * as dns from 'dns';
import { EventEmitter } from 'events';
import { ConfigService } from '../config/config.service';
import { AgentState } from '../config/config.types';
import { AppLogger } from '../logger.service';
import { SftpService } from '../sftp/sftp.service';
import { ExportWatcherService } from '../watcher/export-watcher.service';
import { ImportWatcherService } from '../watcher/import-watcher.service';

const SOURCE = 'Agent';

const HOURLY_RESTART_MS = 60 * 60 * 1000;
const RESTART_DELAY_MS = 2_000;
// Emit a "still alive" log every this-many ms so quiet stores don't look
// like the app has silently died. Also useful for post-incident triage.
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Orchestrates the full pipeline: validate config → connect SFTP →
 * start both watchers. Exposes a single start/stop surface to the IPC layer.
 */
@Injectable()
export class AgentService {
  private state: AgentState = { status: 'idle' };
  private readonly bus = new EventEmitter();

  private restartTimer: NodeJS.Timeout | null = null;
  private restarting = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly exportWatcher: ExportWatcherService,
    private readonly importWatcher: ImportWatcherService,
    private readonly logger: AppLogger,
  ) {}

  getState(): AgentState {
    return { ...this.state };
  }

  onStateChange(cb: (s: AgentState) => void): () => void {
    this.bus.on('state', cb);
    return () => this.bus.off('state', cb);
  }

  private setState(next: Partial<AgentState>): void {
    this.state = { ...this.state, ...next };
    this.bus.emit('state', this.getState());
  }

  async start(): Promise<AgentState> {
    if (this.state.status === 'running') {
      this.logger.warn(SOURCE, 'Already running');
      return this.getState();
    }

    const cfg = this.config.get();

    const missing: string[] = [];

    if (!cfg.sftpUri) missing.push('SFTP URI');
    if (!cfg.folderName) missing.push('Folder Name');
    if (!cfg.importDirectory) missing.push('Import directory');
    if (!cfg.exportDirectory) missing.push('Export directory');

    if (missing.length) {
      const msg = `Missing config: ${missing.join(', ')}`;
      this.logger.error(SOURCE, msg);
      this.setState({ status: 'error', lastError: msg });
      throw new Error(msg);
    }

    try {
      this.logger.info(SOURCE, 'Starting…');

      // force=true — user pressed Start, always tear down any lingering
      // client and rebuild from scratch. Guards against the "zombie
      // connection" scenario where connected=true but the socket is dead.
      await this.sftp.connect(cfg.sftpUri, cfg.sftpPassword, true);

      this.exportWatcher.start();
      this.importWatcher.start();

      this.setState({
        status: 'running',
        lastError: undefined,
        startedAt: new Date().toISOString(),
      });

      this.scheduleHourlyRestart();
      this.scheduleHeartbeat();

      this.logger.success(SOURCE, 'Scale Engine is running');

      return this.getState();
    } catch (err) {
      const msg = (err as Error).message;

      this.logger.error(SOURCE, `Failed to start: ${msg}`);

      try {
        this.exportWatcher.stop();
      } catch {
        /* ignore */
      }

      try {
        this.importWatcher.stop();
      } catch {
        /* ignore */
      }

      try {
        await this.sftp.disconnect();
      } catch {
        /* ignore */
      }

      this.clearHourlyRestart();
      this.clearHeartbeat();

      this.setState({ status: 'error', lastError: msg });

      throw err;
    }
  }

  async stop(): Promise<AgentState> {
    if (this.state.status !== 'running') {
      this.logger.info(SOURCE, 'Stop requested but agent is not running');
    }

    this.logger.info(SOURCE, 'Stopping…');

    this.clearHourlyRestart();
    this.clearHeartbeat();

    try {
      this.exportWatcher.stop();
    } catch {
      /* ignore */
    }

    try {
      this.importWatcher.stop();
    } catch {
      /* ignore */
    }

    try {
      await this.sftp.disconnect();
    } catch {
      /* ignore */
    }

    this.setState({
      status: 'idle',
      lastError: undefined,
      startedAt: undefined,
    });

    this.logger.info(SOURCE, 'Stopped');

    return this.getState();
  }

  private scheduleHourlyRestart(): void {
    if (this.restartTimer) return;

    this.restartTimer = setInterval(() => {
      void this.restart();
    }, HOURLY_RESTART_MS);
  }

  private clearHourlyRestart(): void {
    if (!this.restartTimer) return;

    clearInterval(this.restartTimer);
    this.restartTimer = null;
  }

  /**
   * Periodic "I'm alive" log with basic stats. Serves two purposes:
   *   1. On a quiet store, gives the operator visible evidence the agent is
   *      still ticking even when no files are flowing.
   *   2. Doubles as a post-mortem checkpoint — if the log stopped emitting
   *      at 03:14, we know that's when the process died.
   */
  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), HEARTBEAT_MS);
    // Also emit one immediately so first evidence appears quickly on Start.
    this.emitHeartbeat();
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private emitHeartbeat(): void {
    if (this.state.status !== 'running') return;

    const startedAt = this.state.startedAt ? new Date(this.state.startedAt).getTime() : Date.now();
    const uptimeMs = Date.now() - startedAt;
    const uptime = AgentService.formatDuration(uptimeMs);

    const expLast = this.exportWatcher.getLastSuccessAt();
    const impLast = this.importWatcher.getLastSuccessAt();
    const expAgo = expLast ? AgentService.formatDuration(Date.now() - expLast) : 'never';
    const impAgo = impLast ? AgentService.formatDuration(Date.now() - impLast) : 'never';
    const connected = this.sftp.isConnected() ? 'connected' : 'DISCONNECTED';

    // Memory footprint — helps spot slow leaks over multi-day runs.
    const mem = process.memoryUsage();
    const memStr = `rss=${AgentService.formatBytes(mem.rss)} heap=${AgentService.formatBytes(mem.heapUsed)}`;

    this.logger.info(
      SOURCE,
      `heartbeat: up ${uptime}, sftp ${connected}, export tick ${expAgo} ago, import tick ${impAgo} ago, ${memStr}`,
    );

    // Best-effort DNS check — resolve the SFTP host and log the IP. If Node's
    // DNS cache goes stale after a network change, we see the wrong IP here
    // long before the connection fails. Non-blocking; failures are ignored.
    this.logResolvedIp();
  }

  private logResolvedIp(): void {
    try {
      const cfg = this.config.get();
      const host = SftpService.parseUri(cfg.sftpUri).host;
      dns.lookup(host, { all: false }, (err, address) => {
        if (err) {
          this.logger.warn(SOURCE, `DNS lookup for ${host} failed: ${err.message}`);
          return;
        }
        this.logger.info(SOURCE, `DNS: ${host} -> ${address}`);
      });
    } catch {
      /* URI probably empty or malformed — skip silently */
    }
  }

  private static formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  private static formatDuration(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    const s = Math.floor(ms / 1_000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    if (this.state.status !== 'running') return;

    this.restarting = true;

    try {
      this.logger.info(SOURCE, 'Hourly restart started');

      try {
        this.exportWatcher.stop();
      } catch {
        /* ignore */
      }

      try {
        this.importWatcher.stop();
      } catch {
        /* ignore */
      }

      try {
        await this.sftp.disconnect();
      } catch {
        /* ignore */
      }

      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

      const cfg = this.config.get();

      await this.sftp.connect(cfg.sftpUri, cfg.sftpPassword, true);

      this.exportWatcher.start();
      this.importWatcher.start();

      this.setState({
        status: 'running',
        lastError: undefined,
        startedAt: new Date().toISOString(),
      });

      this.logger.success(SOURCE, 'Hourly restart completed');
    } catch (err) {
      const msg = (err as Error).message;

      this.logger.error(SOURCE, `Hourly restart failed: ${msg}`);

      this.setState({
        status: 'error',
        lastError: msg,
      });
    } finally {
      this.restarting = false;
    }
  }
}