import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CommunicationMediaConfig } from '../config/communication-config.js';

const DRAFTS_PREFIX = 'ops-agent/communication/drafts';
const PUBLISHED_PREFIX = 'ops-agent/communication/published';
const DRAFT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const STORAGE_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 15_000;

export const COMMUNICATION_MEDIA_STORAGE = Symbol(
  'COMMUNICATION_MEDIA_STORAGE',
);

export interface DraftUpload {
  body: Buffer;
  contentType: string;
  extension: string;
}

export interface StoredDraft {
  name: string;
  url: string;
}

export interface MediaStorage {
  uploadDraft(upload: DraftUpload): Promise<StoredDraft>;
  publish(name: string): Promise<string>;
}

export function createMediaStorage(
  config: CommunicationMediaConfig,
): MediaStorage {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Default CRC32 trailers are rejected by S3-compatible stores.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    async uploadDraft({ body, contentType, extension }) {
      const name = `${randomUUID()}.${extension}`;
      const key = `${DRAFTS_PREFIX}/${name}`;
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
      );
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: DRAFT_URL_TTL_SECONDS },
      );
      await verifyImageUrl(url);
      return { name, url };
    },

    async publish(name) {
      const key = `${PUBLISHED_PREFIX}/${name}`;
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: key,
          CopySource: `${config.bucket}/${DRAFTS_PREFIX}/${name}`,
          ACL: 'public-read',
        }),
        { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
      );
      const url = `${config.publicBaseUrl}/${key}`;
      await verifyImageUrl(url);
      return url;
    },
  };
}

// Google Chat renders a broken widget without any API error, and redirected URLs failed in testing.
async function verifyImageUrl(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    // A slow connection from this host says nothing about what Google Chat can reach.
    return;
  }
  await response.body?.cancel();
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !contentType.startsWith('image/'))
    throw new Error(
      `A imagem não ficou acessível (HTTP ${response.status}, ${contentType || 'sem content-type'})`,
    );
}
