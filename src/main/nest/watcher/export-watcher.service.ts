import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../config/config.service';
import { AppLogger } from '../logger.service';
import { SftpService } from '../sftp/sftp.service';

const SOURCE = 'ExportWatcher';
const POLL_MS = 2500;
const STABLE_MS = 1500; // Skip files whose mtime is newer than this (scale may still be writing)
// The middleware listens at /upload/import (it then moves files to /upload/import_processed
// or /upload/import_error after handling). NOT to be confused with the legacy /import at the
// SFTP root, which is unrelated.
const REMOTE_TARGET_DIR = '/upload/import';
const LOCAL_PROCESSED_SUBDIR = 'processed';
// Hard cap on how long a single tick may run. Even a big upload should
// finish well within this. Anything longer is a zombie tick and we
// unwind so the next tick can attempt again.
const TICK_TIMEOUT_MS = 90_000;
// If a tick doesn't complete successfully for this long, log a WARN so the
// operator sees "something is wrong" instead of "log went quiet".
const STALE_TICK_WARN_MS = 5 * 60_000;

/**
 * Watches the LOCAL Export directory (where Mettler Toledo drops weighed-product
 * XML receipts) and uploads new files to the SFTP /upload/import folder, where
 * the middleware picks them up.
 *
 * After a successful upload, the local file is moved to <Export>/processed/
 * so it is not picked up again and so the user can audit history. The remote
 * lifecycle (import → import_processed / import_error) is owned by the
 * middleware, so we do NOT move the remote file ourselves.
 */
@Injectable()
export class ExportWatcherService {
  private timer: NodeJS.Timeout | null = null;
  // Time-based lock instead of a boolean. Even if a tick hangs (impossible
  // now thanks to per-op timeouts, but be defensive) the lock expires and
  // the next tick attempts again.
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
    if (!cfg.exportDirectory) {
      throw new Error('Export directory is not configured');
    }
    if (!fs.existsSync(cfg.exportDirectory)) {
      throw new Error(`Export directory does not exist: ${cfg.exportDirectory}`);
    }
    const processedDir = path.join(cfg.exportDirectory, LOCAL_PROCESSED_SUBDIR);
    fs.mkdirSync(processedDir, { recursive: true });

    this.logger.info(SOURCE, `Watching ${cfg.exportDirectory} → SFTP ${REMOTE_TARGET_DIR}`);
    this.timer = setInterval(() => this.tick().catch((e) => {
      this.logger.error(SOURCE, `tick error: ${(e as Error).message}`);
    }), POLL_MS);
    // Fire one immediately so we don't wait for the first interval
    this.tick().catch((e) => this.logger.error(SOURCE, `initial tick error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Full state reset — this service is a NestJS singleton, so unless we
    // wipe these here they'd survive across Stop→Start cycles inside the
    // same process. `inFlight` in particular could have entries stuck from
    // a hung transfer, which would then silently skip those files forever.
    this.inFlight.clear();
    this.busyUntil = 0;
    this.lastSuccessAt = 0;
    this.staleWarned = false;
    this.logger.info(SOURCE, 'Stopped (state reset)');
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now < this.busyUntil) {
      // Previous tick still in flight — skip. But if the previous tick
      // has been "in flight" for way too long, warn once so we notice.
      if (this.lastSuccessAt > 0 && now - this.lastSuccessAt > STALE_TICK_WARN_MS && !this.staleWarned) {
        this.logger.warn(SOURCE, `No successful tick for ${Math.floor((now - this.lastSuccessAt) / 1000)}s`);
        this.staleWarned = true;
      }
      return;
    }
    this.busyUntil = now + TICK_TIMEOUT_MS;

    // Race the actual work against a hard timeout so a hung SFTP call can
    // never lock us out permanently.
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
    if (!fs.existsSync(cfg.exportDirectory)) return;

    // If we lost the SFTP socket between ticks, wait for it to come back.
    await this.sftp.ensureConnected();

    // Make sure remote inbox exists
    await this.sftp.ensureDir(REMOTE_TARGET_DIR);

    const processedDir = path.join(cfg.exportDirectory, LOCAL_PROCESSED_SUBDIR);
    fs.mkdirSync(processedDir, { recursive: true });

    const entries = fs.readdirSync(cfg.exportDirectory, { withFileTypes: true });
    const now = Date.now();
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.xml')) continue;
      if (this.inFlight.has(e.name)) continue;

      const localPath = path.join(cfg.exportDirectory, e.name);
      const stat = fs.statSync(localPath);
      if (now - stat.mtimeMs < STABLE_MS) continue; // still being written

      this.inFlight.add(e.name);
      try {
        await this.transferOne(localPath, e.name, processedDir);
      } finally {
        this.inFlight.delete(e.name);
      }
    }
  }

  private async transferOne(localPath: string, name: string, processedDir: string): Promise<void> {
    const remotePath = `${REMOTE_TARGET_DIR}/${name}`;
    this.logger.info(SOURCE, `→ uploading ${name}`);
    try {
      await this.sftp.uploadFile(localPath, remotePath);
    } catch (err) {
      this.logger.error(SOURCE, `Upload failed for ${name}: ${(err as Error).message}`);
      return;
    }

    // Move local file to processed (with collision-safe naming)
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const movedName = `${ts}__${name}`;
    const movedPath = path.join(processedDir, movedName);
    try {
      fs.renameSync(localPath, movedPath);
    } catch (err) {
      this.logger.warn(SOURCE, `Uploaded ${name} but failed to move locally: ${(err as Error).message}`);
      return;
    }

    this.logger.success(SOURCE, `✓ ${name} → ${remotePath} (archived as ${movedName})`);
  }
}
