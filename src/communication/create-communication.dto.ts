import { IsNotEmpty, IsString } from 'class-validator';
import { IsNotBlank } from '../common/request-validation.pipe.js';

const TICKET_ID_REQUIRED = 'ticketId is required';
const DELIVERY_SPACE_REQUIRED = 'deliverySpace must be a non-empty string';

export class CreateCommunicationDto {
  @IsString({ message: TICKET_ID_REQUIRED })
  @IsNotEmpty({ message: TICKET_ID_REQUIRED })
  ticketId!: string;

  @IsNotBlank({ message: DELIVERY_SPACE_REQUIRED })
  deliverySpace!: string;
}
