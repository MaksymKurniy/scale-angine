import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger.service';
import { SftpModule } from './sftp/sftp.module';
import { WatcherModule } from './watcher/watcher.module';

@Module({
  imports: [LoggerModule, ConfigModule, SftpModule, WatcherModule, AgentModule],
})
export class AppModule {}
