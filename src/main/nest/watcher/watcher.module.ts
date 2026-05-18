import { Module } from '@nestjs/common';
import { SftpModule } from '../sftp/sftp.module';
import { ExportWatcherService } from './export-watcher.service';
import { ImportWatcherService } from './import-watcher.service';

@Module({
  imports: [SftpModule],
  providers: [ExportWatcherService, ImportWatcherService],
  exports: [ExportWatcherService, ImportWatcherService],
})
export class WatcherModule {}
