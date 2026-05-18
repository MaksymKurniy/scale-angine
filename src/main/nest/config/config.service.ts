import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, DEFAULT_CONFIG } from './config.types';

// Encrypted secrets are stored on disk as "enc:<base64>" so the prefix lets
// us distinguish them from legacy plain-text values during migration.
const ENC_PREFIX = 'enc:';

/**
 * Lazy accessor for Electron's safeStorage. Returns null outside of an
 * Electron runtime (e.g. unit tests) or when the OS keychain backend is
 * unavailable, in which case secrets are written as plain text and a warning
 * is logged once.
 */
function getSafeStorage(): { encryptString: (s: string) => Buffer; decryptString: (b: Buffer) => string } | null {
  try {
    // Inline require so the smoke test outside Electron doesn't blow up.
    const electron = require('electron');
    if (electron?.safeStorage && electron.safeStorage.isEncryptionAvailable()) {
      return electron.safeStorage;
    }
  } catch {
    /* not running inside Electron */
  }
  return null;
}

/**
 * Persists app configuration as JSON in Electron's userData folder.
 * The exact path is resolved lazily because Electron's `app` module is only
 * usable after `app.whenReady()`.
 *
 * The SFTP password is stored using Electron's safeStorage (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux). When safeStorage is unavailable
 * (or for legacy configs from earlier app versions) the password falls back
 * to plain text and the migration runs transparently on the next save.
 */
@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private cached: AppConfig | null = null;
  private configFilePath: string | null = null;
  private encryptionWarned = false;

  /** Called once by the bootstrap layer after Electron is ready. */
  init(configFilePath: string): void {
    this.configFilePath = configFilePath;
    this.logger.log(`Config file: ${configFilePath}`);
  }

  get(): AppConfig {
    if (this.cached) return this.cached;
    if (!this.configFilePath) {
      this.logger.warn('ConfigService used before init() — returning defaults');
      return { ...DEFAULT_CONFIG };
    }
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppConfig>;
        // Decrypt the password if it was stored encrypted.
        const password = this.decryptIfNeeded(parsed.sftpPassword || '');
        this.cached = { ...DEFAULT_CONFIG, ...parsed, sftpPassword: password };
      } else {
        this.cached = { ...DEFAULT_CONFIG };
      }
    } catch (err) {
      this.logger.error(`Failed to read config: ${(err as Error).message}`);
      this.cached = { ...DEFAULT_CONFIG };
    }
    return this.cached;
  }

  save(next: AppConfig): AppConfig {
    if (!this.configFilePath) {
      throw new Error('ConfigService not initialised');
    }
    const sanitized: AppConfig = {
      sftpUri: (next.sftpUri || '').trim(),
      // Passwords are NOT trimmed — a literal trailing space might be meaningful.
      sftpPassword: next.sftpPassword || '',
      folderName: (next.folderName || '').trim(),
      importDirectory: (next.importDirectory || '').trim(),
      exportDirectory: (next.exportDirectory || '').trim(),
    };

    // Persist with the password encrypted; the in-memory cache keeps the
    // plain version so consumers (AgentService, the renderer) don't have to
    // worry about decryption.
    const onDisk: AppConfig = {
      ...sanitized,
      sftpPassword: this.encryptIfPossible(sanitized.sftpPassword),
    };

    fs.mkdirSync(path.dirname(this.configFilePath), { recursive: true });
    fs.writeFileSync(this.configFilePath, JSON.stringify(onDisk, null, 2), 'utf-8');
    this.cached = sanitized;
    this.logger.log('Config saved');
    return sanitized;
  }

  // ---- secret handling -------------------------------------------------

  private encryptIfPossible(plain: string): string {
    if (!plain) return '';
    const ss = getSafeStorage();
    if (!ss) {
      if (!this.encryptionWarned) {
        this.logger.warn('safeStorage unavailable — saving SFTP password as plain text');
        this.encryptionWarned = true;
      }
      return plain;
    }
    try {
      const buf = ss.encryptString(plain);
      return ENC_PREFIX + buf.toString('base64');
    } catch (err) {
      this.logger.warn(`Failed to encrypt password, falling back to plain: ${(err as Error).message}`);
      return plain;
    }
  }

  private decryptIfNeeded(stored: string): string {
    if (!stored) return '';
    if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy / migration path
    const ss = getSafeStorage();
    if (!ss) {
      this.logger.warn('Encrypted password on disk but safeStorage unavailable — cannot decrypt');
      return '';
    }
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
      return ss.decryptString(buf);
    } catch (err) {
      this.logger.warn(`Failed to decrypt password (different OS user or fresh install?): ${(err as Error).message}`);
      return '';
    }
  }
}
