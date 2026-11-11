import 'reflect-metadata';
import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RequestValidationPipe } from './request-validation.pipe.js';
import { CreateDiagnosisDto } from '../diagnosis/create-diagnosis.dto.js';
import { CreateImpactDto } from '../impact/create-impact.dto.js';
import { GrafanaWebhookDto } from '../incidents/grafana-webhook.dto.js';
import { GoogleChatEventDto } from '../google-chat/google-chat-event.dto.js';

const pipe = new RequestValidationPipe();

function body(metatype: ArgumentMetadata['metatype']): ArgumentMetadata {
  return { type: 'body', metatype };
}

async function rejection(
  value: unknown,
  metatype: ArgumentMetadata['metatype'],
) {
  try {
    await pipe.transform(value, body(metatype));
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error('expected validation to fail');
}

function badRequest(message: string) {
  return { message, error: 'Bad Request', statusCode: 400 };
}

describe('CreateDiagnosisDto', () => {
  it('returns a valid payload untouched', async () => {
    const payload = {
      ticketId: ' 86abc ',
      force: true,
      remediation: 'plan',
      googleChatUser: 'users/1',
      extra: 'kept',
    };
    await expect(
      pipe.transform(payload, body(CreateDiagnosisDto)),
    ).resolves.toBe(payload);
  });

  it.each([
    [{}, 'ticketId is required'],
    [{ ticketId: '' }, 'ticketId is required'],
    [{ ticketId: 123 }, 'ticketId is required'],
    [[1], 'ticketId is required'],
    [
      { ticketId: 'x', remediation: 'yes' },
      'remediation must be none, plan, or auto',
    ],
    [
      { ticketId: 'x', googleChatSpace: '  ' },
      'googleChatSpace must be a non-empty string',
    ],
    [
      { ticketId: 'x', googleChatSpace: null, googleChatUser: 5 },
      'googleChatSpace must be a non-empty string',
    ],
    [
      { ticketId: 'x', googleChatSpace: null, googleChatUser: null },
      'googleChatSpace must be a non-empty string',
    ],
  ])('rejects %j', async (payload, message) => {
    await expect(rejection(payload, CreateDiagnosisDto)).resolves.toEqual(
      badRequest(message),
    );
  });

  it.each([
    { ticketId: '   ' },
    { ticketId: 'x', remediation: '' },
    { ticketId: 'x', googleChatSpace: 'spaces/a', googleChatUser: 5 },
    { ticketId: 'x', googleChatSpace: null },
  ])('accepts %j', async (payload) => {
    await expect(
      pipe.transform(payload, body(CreateDiagnosisDto)),
    ).resolves.toBe(payload);
  });
});

describe('CreateImpactDto', () => {
  it('accepts a ticket id surrounded by spaces', async () => {
    const payload = { ticketId: ' 86abc_1 ' };
    await expect(pipe.transform(payload, body(CreateImpactDto))).resolves.toBe(
      payload,
    );
  });

  it.each([
    [{}, 'ticketId is required'],
    [{ ticketId: '   ' }, 'ticketId is required'],
    [{ ticketId: 5 }, 'ticketId is required'],
    [{ ticketId: 'a/b' }, 'ticketId is invalid'],
  ])('rejects %j', async (payload, message) => {
    await expect(rejection(payload, CreateImpactDto)).resolves.toEqual(
      badRequest(message),
    );
  });
});

describe('permissive DTOs', () => {
  it.each([
    [GrafanaWebhookDto, {}],
    [GrafanaWebhookDto, { alerts: 'x' }],
    [GoogleChatEventDto, { type: 'MESSAGE', message: { text: 'oi' } }],
  ])('passes %o bodies through', async (metatype, payload) => {
    await expect(pipe.transform(payload, body(metatype))).resolves.toBe(
      payload,
    );
  });
});
