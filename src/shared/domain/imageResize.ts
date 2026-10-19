export interface ImageDimensions {
  width: number;
  height: number;
}

/** Fit an image inside a square bound while preserving its aspect ratio. */
export function fitImageDimensions(
  width: number,
  height: number,
  maxDimension: number,
): ImageDimensions {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxDimension) ||
    width <= 0 ||
    height <= 0 ||
    maxDimension <= 0
  ) {
    throw new RangeError('Image dimensions and maximum must be positive finite numbers');
  }

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
