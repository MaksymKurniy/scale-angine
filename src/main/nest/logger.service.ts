import { Global, Injectable, Module } from '@nestjs/common';
import { EventEmitter } from 'events';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEvent {
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
}

/**
 * Lightweight in-process log bus. Main process listens and forwards to the
 * renderer via IPC; the renderer renders them into a console-like panel.
 */
@Injectable()
export class AppLogger {
  private readonly bus = new EventEmitter();
  private readonly buffer: LogEvent[] = [];
  private readonly bufferMax = 500;

  emit(source: string, level: LogLevel, message: string): void {
    const evt: LogEvent = {
      ts: new Date().toISOString(),
      level,
      source,
      message,
    };
    this.buffer.push(evt);
    if (this.buffer.length > this.bufferMax) this.buffer.shift();

    // Mirror to stdout for terminal visibility
    const fn =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${source}] ${message}`);

    this.bus.emit('log', evt);
  }

  info(source: string, message: string) { this.emit(source, 'info', message); }
  warn(source: string, message: string) { this.emit(source, 'warn', message); }
  error(source: string, message: string) { this.emit(source, 'error', message); }
  success(source: string, message: string) { this.emit(source, 'success', message); }

  onLog(cb: (evt: LogEvent) => void): () => void {
    this.bus.on('log', cb);
    return () => this.bus.off('log', cb);
  }

  recent(): LogEvent[] {
    return [...this.buffer];
  }
}

@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class LoggerModule {}
