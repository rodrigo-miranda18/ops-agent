import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { GoogleChatNotificationsService } from './google-chat/google-chat-notifications.service.js';

async function notify() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    await app.get(GoogleChatNotificationsService).notifySuccessfulRuns();
  } finally {
    await app.close();
  }
}

void notify();
