import 'reflect-metadata';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { ConfigService } from './config/config.service';
import { AppLogger } from './logger.service';

export interface NestContext {
  app: INestApplicationContext;
  config: ConfigService;
  agent: AgentService;
  logger: AppLogger;
}

export async function bootstrapNest(configFilePath: string): Promise<NestContext> {
  // Nest spams a lot of "Mapped {…}" logs we don't need in an Electron app.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const config = app.get(ConfigService);
  config.init(configFilePath);
  // Prime the cache so the renderer's first read is consistent.
  config.get();

  const agent = app.get(AgentService);
  const logger = app.get(AppLogger);

  Logger.log('NestJS application context ready', 'Bootstrap');
  return { app, config, agent, logger };
}
