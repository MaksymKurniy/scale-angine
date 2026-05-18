import { Module } from '@nestjs/common';
import { SftpService } from './sftp.service';

@Module({
  providers: [SftpService],
  exports: [SftpService],
})
export class SftpModule {}
