import { Module } from '@nestjs/common';
import { StateModule } from '../state/state.module.js';
import { ImpactController } from './impact.controller.js';
import { ImpactExecutionService } from './impact-execution.service.js';

@Module({
  imports: [StateModule],
  controllers: [ImpactController],
  providers: [ImpactExecutionService],
})
export class ImpactModule {}
