import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../config/config.service';
import { AppLogger } from '../logger.service';
import { SftpService } from '../sftp/sftp.service';

const SOURCE = 'ImportWatcher';
const POLL_MS = 2500;
const STABLE_MS = 1500;
// The POS App writes product XMLs into the per-scale "export" subfolder
// (i.e. /upload/<FolderName>/export/). It's named "export" from the POS App's
// perspective but is effectively our INBOX for the scale.
const REMOTE_EXPORT_SUBDIR = 'export';
const REMOTE_PROCESSED_SUBDIR = 'processed';
const TICK_TIMEOUT_MS = 90_000;
const STALE_TICK_WARN_MS = 5 * 60_000;

/**
 * Watches the SFTP /upload/<FolderName>/export/ directory for new product XML
 * files (pushed there by the middleware / POS App) and downloads them into the
 * LOCAL Import directory where Mettler Toledo reads them.
 *
 * After download, the remote file is moved to
 * /upload/<FolderName>/export/processed/ so it is not picked up again.
 */
@Injectable()
export class ImportWatcherService {
  private timer: NodeJS.Timeout | null = null;
  private busyUntil = 0;
  private lastSuccessAt = 0;
  private staleWarned = false;
  private inFlight = new Set<string>();

  getLastSuccessAt(): number {
    return this.lastSuccessAt;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly logger: AppLogger,
  ) {}

  isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    const cfg = this.config.get();
    if (!cfg.folderName) {
      throw new Error('SFTP Folder Name is not configured');
    }
    if (!cfg.importDirectory) {
      throw new Error('Import directory is not configured');
    }
    if (!fs.existsSync(cfg.importDirectory)) {
      throw new Error(`Import directory does not exist: ${cfg.importDirectory}`);
    }

    const remoteDir = this.remoteDir();
    this.logger.info(SOURCE, `Watching SFTP ${remoteDir} → ${cfg.importDirectory}`);
    this.timer = setInterval(() => this.tick().catch((e) => {
      this.logger.error(SOURCE, `tick error: ${(e as Error).message}`);
    }), POLL_MS);
    this.tick().catch((e) => this.logger.error(SOURCE, `initial tick error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Full state reset — see ExportWatcherService.stop() for rationale.
    this.inFlight.clear();
    this.busyUntil = 0;
    this.lastSuccessAt = 0;
    this.staleWarned = false;
    this.logger.info(SOURCE, 'Stopped (state reset)');
  }

  private remoteDir(): string {
    const folder = this.config.get().folderName;
    return `/upload/${folder}/${REMOTE_EXPORT_SUBDIR}`;
  }

  private remoteProcessedDir(): string {
    return `${this.remoteDir()}/${REMOTE_PROCESSED_SUBDIR}`;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now < this.busyUntil) {
      if (this.lastSuccessAt > 0 && now - this.lastSuccessAt > STALE_TICK_WARN_MS && !this.staleWarned) {
        this.logger.warn(SOURCE, `No successful tick for ${Math.floor((now - this.lastSuccessAt) / 1000)}s`);
        this.staleWarned = true;
      }
      return;
    }
    this.busyUntil = now + TICK_TIMEOUT_MS;

    let watchdog: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('tick timed out')), TICK_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.doTick(), timeout]);
      this.lastSuccessAt = Date.now();
      this.staleWarned = false;
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(SOURCE, `tick aborted: ${msg}`);
    } finally {
      clearTimeout(watchdog!);
      this.busyUntil = 0;
    }
  }

  private async doTick(): Promise<void> {
    const cfg = this.config.get();
    const remoteDir = this.remoteDir();
    const processedRemote = this.remoteProcessedDir();

    // If we lost the SFTP socket between ticks, wait for it to come back.
    await this.sftp.ensureConnected();

    // Ensure both remote dir and remote processed dir exist
    await this.sftp.ensureDir(remoteDir);
    await this.sftp.ensureDir(processedRemote);

    const files = await this.sftp.listXmlFiles(remoteDir);
    const now = Date.now();
    for (const f of files) {
      if (this.inFlight.has(f.name)) continue;
      // f.modifyTime is in ms since epoch (per ssh2-sftp-client)
      if (now - f.modifyTime < STABLE_MS) continue;

      this.inFlight.add(f.name);
      try {
        await this.transferOne(f.name, remoteDir, processedRemote, cfg.importDirectory);
      } finally {
        this.inFlight.delete(f.name);
      }
    }
  }

  private async transferOne(
    name: string,
    remoteDir: string,
    remoteProcessed: string,
    localImportDir: string,
  ): Promise<void> {
    const remotePath = `${remoteDir}/${name}`;
    const localPath = path.join(localImportDir, name);
    this.logger.info(SOURCE, `← downloading ${name}`);
    try {
      await this.sftp.downloadFile(remotePath, localPath);
    } catch (err) {
      this.logger.error(SOURCE, `Download failed for ${name}: ${(err as Error).message}`);
      return;
    }

    // Move on remote to processed/
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const movedName = `${ts}__${name}`;
    const movedRemote = `${remoteProcessed}/${movedName}`;
    try {
      await this.sftp.moveRemote(remotePath, movedRemote);
    } catch (err) {
      this.logger.warn(SOURCE, `Downloaded ${name} but failed to move remote: ${(err as Error).message}`);
      return;
    }

    this.logger.success(SOURCE, `✓ ${name} → ${localPath} (remote archived as ${movedName})`);
  }
}
