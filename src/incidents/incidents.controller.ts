import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IncidentsService } from './incidents.service.js';
import { GrafanaWebhookDto } from './grafana-webhook.dto.js';
import { GrafanaWebhookGuard } from './grafana-webhook.guard.js';
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}
  @Post('grafana')
  @UseGuards(GrafanaWebhookGuard)
  async grafana(@Body() body: GrafanaWebhookDto) {
    return this.incidents.ingestGrafana(body);
  }
}
