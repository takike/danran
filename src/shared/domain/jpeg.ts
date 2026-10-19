export interface JpegInfo {
  width: number;
  height: number;
  hasExif: boolean;
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Reads JPEG structure without decoding pixels. Returns null for malformed or non-JPEG input. */
export function inspectJpeg(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let hasExif = false;
  let sawScan = false;
  let sawFrame = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset] ?? -1;
    offset++;

    if (marker === 0xd9) {
      if (!sawScan || width === null || height === null || offset !== bytes.length) return null;
      return { width, height, hasExif };
    }
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return null;
    }
    if (offset + 2 > bytes.length) return null;
    const segmentLength = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const dataStart = offset + 2;
    const dataEnd = offset + segmentLength;

    if (marker === 0xe1 && dataEnd - dataStart >= 6) {
      hasExif ||=
        bytes[dataStart] === 0x45 &&
        bytes[dataStart + 1] === 0x78 &&
        bytes[dataStart + 2] === 0x69 &&
        bytes[dataStart + 3] === 0x66 &&
        bytes[dataStart + 4] === 0x00 &&
        bytes[dataStart + 5] === 0x00;
    }

    if (SOF_MARKERS.has(marker)) {
      if (sawFrame) return null;
      if (dataEnd - dataStart < 6) return null;
      const parsedHeight = ((bytes[dataStart + 1] ?? 0) << 8) | (bytes[dataStart + 2] ?? 0);
      const parsedWidth = ((bytes[dataStart + 3] ?? 0) << 8) | (bytes[dataStart + 4] ?? 0);
      const components = bytes[dataStart + 5] ?? 0;
      if (parsedWidth < 1 || parsedHeight < 1 || components < 1) return null;
      if (dataEnd - dataStart !== 6 + components * 3) return null;
      width = parsedWidth;
      height = parsedHeight;
      sawFrame = true;
    }

    offset = dataEnd;
    if (marker !== 0xda) continue;
    if (!sawFrame) return null;
    if (dataEnd - dataStart < 4) return null;
    const components = bytes[dataStart] ?? 0;
    if (components < 1 || dataEnd - dataStart !== 4 + components * 2) return null;
    sawScan = true;

    // Scan data treats FF00 as a literal FF and FFD0-FFD7 as restart markers.
    // Any other marker ends this scan and is parsed by the outer marker loop.
    let foundFollowingMarker = false;
    while (offset < bytes.length) {
      const markerStart = offset;
      if (bytes[offset++] !== 0xff) continue;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return null;
      const scanMarker = bytes[offset] ?? -1;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset++;
        continue;
      }
      offset = markerStart;
      foundFollowingMarker = true;
      break;
    }
    if (!foundFollowingMarker) return null;
  }
  return null;
}
