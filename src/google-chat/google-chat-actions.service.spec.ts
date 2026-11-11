import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import {
  clickUpCommentMarker,
  GoogleChatActionsService,
  sha256,
} from './google-chat-actions.service.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';

class MemoryState {
  files = {};

  async read(name) {
    return this.files[name] || {};
  }

  async update(name, mutate) {
    const value = this.files[name] || {};
    mutate(value);
    this.files[name] = value;
    return value;
  }
}

function incidentService(
  issues,
  github = {},
  userMap = { 'pessoa8@example.com': 'dev-github' },
) {
  const state = new MemoryState();
  const calls = { assign: [], comment: [], messages: [] };
  const config = googleChatConfig({
    GOOGLE_CHAT_ACTION_URL: 'https://ops.example.com/google-chat/events',
    GITHUB_CHAT_USER_MAP:
      typeof userMap === 'string' ? userMap : JSON.stringify(userMap),
  });
  const messenger = new GoogleChatMessengerService(config);
  messenger.sendMessage = async (space, message) => {
    calls.messages.push({ space, text: message.text });
    return { messageName: 'spaces/AAA/messages/1' };
  };
  const service = new GoogleChatActionsService(
    state,
    {},
    {
      assignIssue: async (url, login) => {
        calls.assign.push({ url, login });
        if (github.assignIssue) return github.assignIssue(url, login);
      },
      commentIssue: async (url, body) => {
        calls.comment.push({ url, body });
        if (github.commentIssue) return github.commentIssue(url, body);
      },
    },
    messenger,
    config,
  );
  state.files['incident-assumptions.json'] = {
    'incident-1': {
      id: 'incident-1',
      incidentId: 'grafana-abc',
      incidentUpdatedAt: '2026-09-19T00:00:00.000Z',
      incidentName: 'Falha no envio de e-mails',
      allowedSpaces: ['spaces/AAA'],
      issues,
      status: 'pending',
      createdAt: '2026-09-19T00:00:00.000Z',
    },
  };
  return { service, state, calls };
}

function assumeIncidentEvent(email = 'pessoa8@example.com') {
  return {
    commonEventObject: {
      invokedFunction: 'assume_incident',
      parameters: { approvalId: 'incident-1' },
    },
    space: { name: 'spaces/AAA' },
    user: { displayName: 'Rodrigo', email },
  };
}

it('assuming an incident assigns every issue and announces it in the chat', async () => {
  const { service, state, calls } = incidentService([
    {
      repository: 'service-15',
      url: 'https://github.com/Example-org/service-15/issues/7',
    },
    {
      repository: 'service-05',
      url: 'https://github.com/Example-org/service-05/issues/3',
    },
  ]);

  const response = await service.handleAction(assumeIncidentEvent());

  expect(calls.assign.map(({ url, login }) => [url, login])).toStrictEqual([
    ['https://github.com/Example-org/service-15/issues/7', 'dev-github'],
    ['https://github.com/Example-org/service-05/issues/3', 'dev-github'],
  ]);
  expect(calls.comment.length).toBe(2);
  expect(calls.messages.length).toBe(1);
  expect(calls.messages[0].space).toBe('spaces/AAA');
  expect(
    calls.messages[0].text.includes(
      'Rodrigo assumiu o incidente Falha no envio de e-mails',
    ),
  ).toBe(true);
  expect(response.text.includes('Incidente assumido por Rodrigo')).toBe(true);

  const record = state.files['incident-assumptions.json']['incident-1'];
  expect(record.status).toBe('assumed');
  expect(record.assumedBy).toBe('Rodrigo');
  expect(record.assumedByGithub).toBe('dev-github');
  expect(
    record.githubAssignments.map(({ repository, status }) => [
      repository,
      status,
    ]),
  ).toStrictEqual([
    ['service-15', 'assigned'],
    ['service-05', 'assigned'],
  ]);
});

it('a second click reports the incident as already assumed without touching GitHub', async () => {
  const { service, calls } = incidentService([
    {
      repository: 'service-15',
      url: 'https://github.com/Example-org/service-15/issues/7',
    },
  ]);

  await service.handleAction(assumeIncidentEvent());
  const response = await service.handleAction({
    ...assumeIncidentEvent('outrpessoa1@example.com'),
    user: { displayName: 'Outra Pessoa', email: 'outrpessoa1@example.com' },
  });

  expect(response).toStrictEqual({
    text: 'Incidente já assumido por Rodrigo.',
  });
  expect(calls.assign.length).toBe(1);
  expect(calls.messages.length).toBe(1);
});

it('an unmapped e-mail still announces the assumption without assigning issues', async () => {
  const { service, state, calls } = incidentService(
    [
      {
        repository: 'service-15',
        url: 'https://github.com/Example-org/service-15/issues/7',
      },
    ],
    {},
    { 'outrpessoa1@example.com': 'outra-pessoa' },
  );

  const response = await service.handleAction(assumeIncidentEvent());

  expect(calls.assign.length).toBe(0);
  expect(calls.messages.length).toBe(1);
  expect(calls.messages[0].text.includes('Rodrigo assumiu o incidente')).toBe(
    true,
  );
  expect(response.text.includes('Nenhum usuário do GitHub mapeado')).toBe(true);
  expect(
    state.files['incident-assumptions.json']['incident-1'].assumedByGithub,
  ).toBe(undefined);
});

it('a malformed GITHUB_CHAT_USER_MAP still announces the assumption instead of breaking the action', async () => {
  const { service, state, calls } = incidentService(
    [
      {
        repository: 'service-15',
        url: 'https://github.com/Example-org/service-15/issues/7',
      },
    ],
    {},
    'pessoa9@example.com:thihxm',
  );

  const response = await service.handleAction(assumeIncidentEvent());

  expect(calls.assign.length).toBe(0);
  expect(calls.messages.length).toBe(1);
  expect(calls.messages[0].text.includes('Rodrigo assumiu o incidente')).toBe(
    true,
  );
  expect(response.text.includes('Nenhum usuário do GitHub mapeado')).toBe(true);
  expect(state.files['incident-assumptions.json']['incident-1'].status).toBe(
    'assumed',
  );
});

it('a failing repository does not block the other issues nor the chat notice', async () => {
  const { service, state, calls } = incidentService(
    [
      {
        repository: 'service-15',
        url: 'https://github.com/Example-org/service-15/issues/7',
      },
      {
        repository: 'service-05',
        url: 'https://github.com/Example-org/service-05/issues/3',
      },
    ],
    {
      assignIssue: async (url) => {
        if (url.includes('service-15'))
          throw new Error('gh issue edit failed (1): not found');
      },
    },
  );

  const response = await service.handleAction(assumeIncidentEvent());

  expect(calls.comment.map(({ url }) => url)).toStrictEqual([
    'https://github.com/Example-org/service-05/issues/3',
  ]);
  expect(calls.messages.length).toBe(1);
  expect(response.text.includes('Falha ao atribuir em service-15')).toBe(true);
  expect(
    state.files['incident-assumptions.json'][
      'incident-1'
    ].githubAssignments.map(({ repository, status }) => [repository, status]),
  ).toStrictEqual([
    ['service-15', 'failed'],
    ['service-05', 'assigned'],
  ]);
});

it('reuses a ClickUp comment found by its stable approval marker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'approval-action-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const commentPath = path.join(directory, 'comment.md');
  const comment = 'Comentário aprovado';
  await writeFile(commentPath, comment);
  const state = new MemoryState();
  state.files['approvals.json'] = {
    approval: {
      id: 'approval',
      taskId: '42',
      taskUpdatedAt: '2026-10-03T12:00:00.000Z',
      ticketName: 'Ticket',
      commentPath,
      commentHash: sha256(comment),
      allowedSpaces: ['spaces/AAA'],
      status: 'pending',
      createdAt: '2026-10-03T12:00:00.000Z',
    },
  };
  const findCommentByMarker = vi.fn(async () => 'comment-existing');
  const addComment = vi.fn();
  const service = new GoogleChatActionsService(
    state,
    {
      getTask: async () => ({
        date_updated: String(Date.parse('2026-10-03T12:00:00.000Z')),
      }),
      findCommentByMarker,
      addComment,
      moveToInDevelopment: async () => ({}),
    },
    {},
    {},
    googleChatConfig({
      GOOGLE_CHAT_ACTION_URL: 'https://ops.example.com/google-chat/events',
    }),
  );

  await service.handleAction({
    commonEventObject: {
      invokedFunction: 'approve_cs_comment',
      parameters: { approvalId: 'approval' },
    },
    space: { name: 'spaces/AAA' },
    user: { displayName: 'Dev' },
  });

  expect(findCommentByMarker).toHaveBeenCalledWith(
    '42',
    clickUpCommentMarker('approval', sha256(comment)),
  );
  expect(addComment).not.toHaveBeenCalled();
  expect(state.files['approvals.json'].approval).toMatchObject({
    status: 'approved',
    clickupCommentId: 'comment-existing',
  });
});
