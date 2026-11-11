import { Allow } from 'class-validator';

export class GrafanaWebhookDto {
  @Allow()
  alerts?: unknown;
}
