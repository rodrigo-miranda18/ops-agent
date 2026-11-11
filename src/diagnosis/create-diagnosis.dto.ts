import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { IsNotBlank } from '../common/request-validation.pipe.js';
import { REMEDIATION_MODES, type RemediationMode } from './diagnosis-run.js';

const TICKET_ID_REQUIRED = 'ticketId is required';
const INVALID_REMEDIATION = 'remediation must be none, plan, or auto';
const INVALID_SPACE = 'googleChatSpace must be a non-empty string';

export class CreateDiagnosisDto {
  @IsString({ message: TICKET_ID_REQUIRED })
  @IsNotEmpty({ message: TICKET_ID_REQUIRED })
  ticketId!: string;

  force?: boolean;

  notify?: boolean;

  @ValidateIf((dto: CreateDiagnosisDto) => Boolean(dto.remediation))
  @IsIn(REMEDIATION_MODES, { message: INVALID_REMEDIATION })
  remediation?: RemediationMode;

  @ValidateIf((dto: CreateDiagnosisDto) => dto.googleChatSpace != null)
  @IsNotBlank({ message: INVALID_SPACE })
  googleChatSpace?: string;

  @ValidateIf(
    (dto: CreateDiagnosisDto) =>
      dto.googleChatSpace == null && dto.googleChatUser !== undefined,
  )
  @IsNotBlank({ message: INVALID_SPACE })
  googleChatUser?: string;
}
