import { Module } from '@nestjs/common';
import { createInstanceId } from './owner-identity.js';
import { STATE_INSTANCE_ID, StateService } from './state.service.js';

@Module({
  providers: [
    {
      provide: STATE_INSTANCE_ID,
      useFactory: createInstanceId,
    },
    StateService,
  ],
  exports: [STATE_INSTANCE_ID, StateService],
})
export class StateModule {}
