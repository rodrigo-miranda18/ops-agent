import { describe, expect, it } from 'vitest';
import {
  detectImageType,
  MAX_PUBLISHED_IMAGES,
  selectManifestImages,
} from './communication-media.js';

describe('detectImageType', () => {
  it('uses the file bytes', () => {
    expect(
      detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])),
    ).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      contentType: 'image/jpeg',
      extension: 'jpg',
    });
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('selectManifestImages', () => {
  const manifest = [1, 2, 3, 4, 5, 6].map((index) => ({
    index,
    file: `${index}.png`,
  }));

  it('drops unknown and repeated indexes with a warning for unknown ones', () => {
    const { selected, warnings } = selectManifestImages(
      [
        { index: 2, caption: 'a' },
        { index: 2, caption: 'b' },
        { index: 9, caption: 'c' },
      ],
      manifest,
    );
    expect(selected).toEqual([{ entry: manifest[1], caption: 'a' }]);
    expect(warnings).toEqual(['Imagem 9 não existe na task e foi ignorada.']);
  });

  it('caps the selection and warns about the rest', () => {
    const { selected, warnings } = selectManifestImages(
      manifest.map(({ index }) => ({ index, caption: 'x' })),
      manifest,
    );
    expect(selected).toHaveLength(MAX_PUBLISHED_IMAGES);
    expect(warnings).toHaveLength(2);
  });
});
