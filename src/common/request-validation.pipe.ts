import {
  BadRequestException,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { ValidateBy, type ValidationOptions } from 'class-validator';

export function firstValidationMessage(errors: ValidationError[]): string {
  for (const error of errors) {
    const message = Object.values(error.constraints ?? {})[0];
    if (message) return message;
    const nested = firstValidationMessage(error.children ?? []);
    if (nested) return nested;
  }
  return 'Bad Request';
}

export class RequestValidationPipe extends ValidationPipe {
  override createExceptionFactory() {
    return (errors: ValidationError[] = []) =>
      new BadRequestException(firstValidationMessage(errors));
  }
}

export function IsNotBlank(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isNotBlank',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && value.trim() !== '',
      },
    },
    options,
  );
}
