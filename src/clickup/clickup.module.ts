import { Module } from '@nestjs/common';
import { ClickUpService } from './clickup.service.js';

@Module({
  providers: [ClickUpService],
  exports: [ClickUpService],
})
export class ClickUpModule {}
