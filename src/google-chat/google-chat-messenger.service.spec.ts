import { afterEach, expect, it, vi } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';

function messenger(env = {}, headers = { Authorization: 'Bearer test' }) {
  const service = new GoogleChatMessengerService(
    googleChatConfig({
      GOOGLE_CHAT_ACTION_URL: 'https://ops.example.com/google-chat/events',
      ...env,
    }),
  );
  Object.assign(service, {
    auth: {
      getClient: async () => ({ getRequestHeaders: async () => headers }),
    },
  });
  return service;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('prefixes bare space ids with spaces/', () => {
  const service = messenger();
  expect(service.normalizeSpaceName('AAA')).toBe('spaces/AAA');
  expect(service.normalizeSpaceName('spaces/AAA')).toBe('spaces/AAA');
});

it('resolves vector spaces ignoring case and surrounding spaces, without duplicates', () => {
  const service = messenger({
    GOOGLE_CHAT_VECTOR_SPACES_JSON: JSON.stringify({
      Conexões: ['spaces/SPACE_ID_1', 'spaces/GERAL'],
      Engajamento: ['spaces/GERAL'],
    }),
  });
  expect(
    service.resolveSpaces([' CONEXÕES ', 'engajamento', 'conexoes']),
  ).toStrictEqual(['spaces/SPACE_ID_1', 'spaces/GERAL']);
});

it('posts text to the thread and returns message and thread names', async () => {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({
        name: 'spaces/AAA/messages/1',
        thread: { name: 'spaces/AAA/threads/123' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const sent = await messenger().sendText(
    'spaces/AAA',
    'Olá',
    'spaces/AAA/threads/123',
  );

  expect(sent).toStrictEqual({
    messageName: 'spaces/AAA/messages/1',
    threadName: 'spaces/AAA/threads/123',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain('spaces/AAA/messages');
  expect(requests[0].body).toStrictEqual({
    text: 'Olá',
    thread: { name: 'spaces/AAA/threads/123' },
  });
});

it('posts failure text as a strict reply instead of creating another thread', async () => {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('thread not found', { status: 404 });
  });

  await expect(
    messenger().sendText('spaces/AAA', 'A geração falhou', {
      threadName: 'spaces/AAA/threads/123',
      requireExistingThread: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(requests).toEqual([
    {
      url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL',
      body: {
        text: 'A geração falhou',
        thread: { name: 'spaces/AAA/threads/123' },
      },
    },
  ]);
});

it('throws with status when the Chat API rejects the message', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response('forbidden', { status: 403 }),
  );

  await expect(
    messenger().sendMessage('spaces/AAA', { text: 'Olá' }),
  ).rejects.toMatchObject({
    message: 'Google Chat API 403: forbidden',
    status: 403,
    operation: 'createMessage',
  });
});

it('fails before calling the API without an Authorization header', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);

  await expect(
    messenger({}, {}).sendMessage('spaces/AAA', { text: 'Olá' }),
  ).rejects.toThrow(
    'Google authentication did not produce an Authorization header',
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('resolves an email membership to its canonical numeric Chat user name', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        member: { name: 'users/123456', type: 'HUMAN' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await messenger().resolveMemberName('AAA', 'ANPESSOA1@example.com'),
  ).toBe('users/123456');
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://chat.googleapis.com/v1/spaces/AAA/members/anpessoa1%40example.com',
  );
  expect(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'),
  ).toBe('Bearer test');
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it.each([
  { member: { name: 'users/anpessoa1@example.com', type: 'HUMAN' } },
  { member: { name: 'users/123456', type: 'BOT' } },
  { member: { name: 'users/123456', type: 'HUMAN' }, state: 'INVITED' },
  {},
])(
  'does not resolve an invalid or inactive human identity (%j)',
  async (body) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body)));
    expect(
      await messenger().resolveMemberName(
        'spaces/AAA',
        'anpessoa1@example.com',
      ),
    ).toBeNull();
  },
);

it('returns null for a missing membership', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response('not found', { status: 404 }),
  );
  expect(
    await messenger().resolveMemberName('spaces/AAA', 'anpessoa1@example.com'),
  ).toBeNull();
});

it('throws on membership permission or authentication failures', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response('forbidden', { status: 403 }),
  );
  await expect(
    messenger().resolveMemberName('spaces/AAA', 'anpessoa1@example.com'),
  ).rejects.toMatchObject({ status: 403 });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    messenger({}, {}).resolveMemberName('spaces/AAA', 'anpessoa1@example.com'),
  ).rejects.toThrow('Authorization header');
  expect(fetchMock).not.toHaveBeenCalled();
});
