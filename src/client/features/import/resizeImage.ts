import { fitImageDimensions } from '@shared/domain/imageResize';
import { MAX_IMPORT_BYTES, MAX_IMPORT_DIMENSION } from '@shared/schemas/imports';

const JPEG_QUALITIES = [0.8, 0.65, 0.5] as const;

export class ImageResizeError extends Error {
  constructor(public readonly kind: 'invalid-image' | 'too-large') {
    super(
      kind === 'invalid-image' ? '画像を読み込めませんでした。' : '写真のサイズが大きすぎます。',
    );
    this.name = 'ImageResizeError';
  }
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ImageResizeError('invalid-image'));
      },
      'image/jpeg',
      quality,
    );
  });
}

export async function resizeImageFile(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageResizeError('invalid-image');
  }

  try {
    const { width, height } = fitImageDimensions(bitmap.width, bitmap.height, MAX_IMPORT_DIMENSION);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new ImageResizeError('invalid-image');
    context.drawImage(bitmap, 0, 0, width, height);

    for (const quality of JPEG_QUALITIES) {
      const blob = await encodeJpeg(canvas, quality);
      if (blob.size <= MAX_IMPORT_BYTES && blob.type === 'image/jpeg') {
        return { blob, width, height };
      }
    }
    throw new ImageResizeError('too-large');
  } catch (error: unknown) {
    if (error instanceof ImageResizeError) throw error;
    throw new ImageResizeError('invalid-image');
  } finally {
    bitmap.close();
  }
}
