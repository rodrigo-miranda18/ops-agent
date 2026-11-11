import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, appConfigFromEnv } from './app-config.js';
import { AUTH_CONFIG, authConfig } from './auth-config.js';
import { CLICKUP_CONFIG, clickUpConfig } from './clickup-config.js';
import {
  COMMUNICATION_CONFIG,
  communicationConfigFromEnv,
} from './communication-config.js';
import { GOOGLE_CHAT_CONFIG, googleChatConfig } from './google-chat-config.js';
import { GITHUB_CONFIG, githubConfigFromEnv } from './github-config.js';
import { RUNTIME_CONFIG, runtimeConfig } from './runtime-config.js';
import {
  STORAGE_MAINTENANCE_CONFIG,
  storageMaintenanceConfig,
} from './storage-maintenance-config.js';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => appConfigFromEnv() },
    { provide: AUTH_CONFIG, useFactory: () => authConfig() },
    { provide: CLICKUP_CONFIG, useFactory: () => clickUpConfig() },
    {
      provide: COMMUNICATION_CONFIG,
      useFactory: () => communicationConfigFromEnv(),
    },
    { provide: GOOGLE_CHAT_CONFIG, useFactory: () => googleChatConfig() },
    { provide: GITHUB_CONFIG, useFactory: () => githubConfigFromEnv() },
    { provide: RUNTIME_CONFIG, useFactory: () => runtimeConfig() },
    {
      provide: STORAGE_MAINTENANCE_CONFIG,
      useFactory: () => storageMaintenanceConfig(),
    },
  ],
  exports: [
    APP_CONFIG,
    AUTH_CONFIG,
    CLICKUP_CONFIG,
    COMMUNICATION_CONFIG,
    GOOGLE_CHAT_CONFIG,
    GITHUB_CONFIG,
    RUNTIME_CONFIG,
    STORAGE_MAINTENANCE_CONFIG,
  ],
})
export class ConfigModule {}
