import { Injectable } from '@nestjs/common';
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

      await this.sftp.connect(cfg.sftpUri, cfg.sftpPassword);

      this.exportWatcher.start();
      this.importWatcher.start();

      this.setState({
        status: 'running',
        lastError: undefined,
        startedAt: new Date().toISOString(),
      });

      this.scheduleHourlyRestart();

      this.logger.success(SOURCE, 'Scale Angine is running');

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

      await this.sftp.connect(cfg.sftpUri, cfg.sftpPassword);

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