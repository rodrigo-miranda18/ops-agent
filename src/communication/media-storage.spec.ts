import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaStorage } from './media-storage.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = send;
    },
    PutObjectCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    CopyObjectCommand: class extends Command {},
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(() => Promise.resolve('https://signed.example/draft')),
}));

const config = {
  bucket: 'media-bucket',
  region: 'region-1',
  endpoint: 'https://s3.example-cloud.net',
  accessKeyId: 'id',
  secretAccessKey: 'secret',
  publicBaseUrl: 'https://cdn.example',
};
const upload = {
  body: Buffer.from('png'),
  contentType: 'image/png',
  extension: 'png',
};

function stubFetch(status: number, contentType: string) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(status === 301 ? null : 'x', {
        status,
        headers: { 'content-type': contentType },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentInput(call = 0) {
  return (send.mock.calls[call]?.[0] as { input: Record<string, unknown> })
    .input;
}

describe('createMediaStorage', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads drafts as private objects with a random name', async () => {
    const fetchMock = stubFetch(200, 'image/png');
    const draft = await createMediaStorage(config).uploadDraft(upload);

    expect(draft.url).toBe('https://signed.example/draft');
    expect(draft.name).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(sentInput()).toMatchObject({
      Bucket: 'media-bucket',
      Key: `ops-agent/communication/drafts/${draft.name}`,
      ContentType: 'image/png',
    });
    expect(sentInput()).not.toHaveProperty('ACL');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://signed.example/draft',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('publishes by copying with a public ACL', async () => {
    stubFetch(200, 'image/png');
    const url = await createMediaStorage(config).publish('a.png');

    expect(url).toBe(
      'https://cdn.example/ops-agent/communication/published/a.png',
    );
    expect(sentInput()).toMatchObject({
      Key: 'ops-agent/communication/published/a.png',
      CopySource: 'media-bucket/ops-agent/communication/drafts/a.png',
      ACL: 'public-read',
    });
  });

  it.each([
    [301, 'text/html'],
    [403, 'application/xml'],
    [200, 'text/html'],
  ])('rejects an unusable URL (%i %s)', async (status, contentType) => {
    stubFetch(status, contentType);
    await expect(createMediaStorage(config).publish('a.png')).rejects.toThrow(
      'A imagem não ficou acessível',
    );
  });

  it('keeps the image when the verification cannot connect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(createMediaStorage(config).publish('a.png')).resolves.toBe(
      'https://cdn.example/ops-agent/communication/published/a.png',
    );
  });
});
