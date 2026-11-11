import { ValidateBy } from 'class-validator';
import { IsNotBlank } from '../common/request-validation.pipe.js';

const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class CreateImpactDto {
  @IsNotBlank({ message: 'ticketId is required' })
  @ValidateBy(
    {
      name: 'isTicketId',
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' ||
          !value.trim() ||
          TICKET_ID_PATTERN.test(value.trim()),
      },
    },
    { message: 'ticketId is invalid' },
  )
  ticketId!: string;
}
