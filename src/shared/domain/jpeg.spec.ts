import { describe, expect, it } from 'vitest';
import { inspectJpeg } from './jpeg';

function segment(marker: number, data: number[]) {
  const length = data.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...data];
}

function jpeg(width = 320, height = 240, extra: number[] = []) {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]),
    ...extra,
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    0x13,
    0xff,
    0x00,
    0x14,
    0xff,
    0xd9,
  ]);
}

describe('inspectJpeg', () => {
  it('reads dimensions and accepts stuffed entropy bytes', () => {
    expect(inspectJpeg(jpeg())).toEqual({ width: 320, height: 240, hasExif: false });
  });

  it('detects an EXIF APP1 segment', () => {
    expect(inspectJpeg(jpeg(320, 240, segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0])))).toEqual({
      width: 320,
      height: 240,
      hasExif: true,
    });
  });

  it.each([
    ['PNG signature', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [
      'HEIC signature',
      new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
    ],
    ['truncated JPEG', jpeg().slice(0, -2)],
    [
      'JPEG without a frame',
      new Uint8Array([0xff, 0xd8, ...segment(0xda, [1, 1, 0, 0, 63, 0]), 1, 0xff, 0xd9]),
    ],
  ])('rejects %s', (_name, bytes) => {
    expect(inspectJpeg(bytes)).toBeNull();
  });

  it('rejects repeated SOF markers instead of using later dimensions', () => {
    const value = jpeg(5000, 240);
    const firstFrameLength = (value[4] ?? 0) * 256 + (value[5] ?? 0);
    const frame = Array.from(value.slice(2, 4 + firstFrameLength));
    const secondFrame = segment(0xc0, [8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    const scanStart = 2 + frame.length;
    expect(
      inspectJpeg(
        new Uint8Array([...value.slice(0, scanStart), ...secondFrame, ...value.slice(scanStart)]),
      ),
    ).toBeNull();
  });
});
