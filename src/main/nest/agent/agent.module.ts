import { Module } from '@nestjs/common';
import { SftpModule } from '../sftp/sftp.module';
import { WatcherModule } from '../watcher/watcher.module';
import { AgentService } from './agent.service';

@Module({
  imports: [SftpModule, WatcherModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
