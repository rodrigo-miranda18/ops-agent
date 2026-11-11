import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppHealthController {
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
