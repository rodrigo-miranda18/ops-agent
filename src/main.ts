import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { appConfigFromEnv } from './config/app-config.js';
import { RequestValidationPipe } from './common/request-validation.pipe.js';

async function bootstrap() {
  const config = appConfigFromEnv();
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new RequestValidationPipe());
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap();
