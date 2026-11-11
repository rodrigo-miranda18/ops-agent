import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize } from '../common/sanitize.js';
import type { CommunicationImage } from './communication-output.js';
import type { MediaStorage } from './media-storage.js';

export const MAX_PUBLISHED_IMAGES = 4;
const LARGE_IMAGE_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export interface ImageManifestEntry {
  index: number;
  file: string;
}

export interface MediaImage {
  name: string;
  url: string;
  caption: string;
}

export interface ImageType {
  contentType: string;
  extension: string;
}

export function detectImageType(bytes: Buffer): ImageType | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return { contentType: 'image/png', extension: 'png' };
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE))
    return { contentType: 'image/jpeg', extension: 'jpg' };
  return null;
}

export function selectManifestImages(
  images: CommunicationImage[],
  manifest: ImageManifestEntry[],
) {
  const warnings: string[] = [];
  const selected: { entry: ImageManifestEntry; caption: string }[] = [];
  const seen = new Set<number>();
  for (const image of images) {
    if (seen.has(image.index)) continue;
    seen.add(image.index);
    const entry = manifest.find((item) => item.index === image.index);
    if (!entry) {
      warnings.push(`Imagem ${image.index} não existe na task e foi ignorada.`);
      continue;
    }
    if (selected.length === MAX_PUBLISHED_IMAGES) {
      warnings.push(
        `Imagem ${image.index} ignorada: limite de ${MAX_PUBLISHED_IMAGES} imagens.`,
      );
      continue;
    }
    selected.push({ entry, caption: image.caption });
  }
  return { selected, warnings };
}

export async function uploadSelectedImages(
  storage: MediaStorage,
  images: CommunicationImage[],
  manifest: ImageManifestEntry[],
  imagesDir: string,
) {
  const { selected, warnings } = selectManifestImages(images, manifest);
  const media: MediaImage[] = [];
  for (const { entry, caption } of selected) {
    try {
      const body = await readFile(path.join(imagesDir, entry.file));
      const type = detectImageType(body);
      if (!type) {
        warnings.push(
          `Imagem ${entry.index} ignorada: só PNG e JPEG podem ser publicados.`,
        );
        continue;
      }
      if (body.length > LARGE_IMAGE_BYTES)
        warnings.push(
          `Imagem ${entry.index} tem mais de 2 MB: confira se ela carregou no card.`,
        );
      const draft = await storage.uploadDraft({ body, ...type });
      media.push({ ...draft, caption });
    } catch (error) {
      warnings.push(
        `Imagem ${entry.index} não foi enviada: ${sanitize(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
      );
    }
  }
  return { media, warnings };
}
