import { describe, expect, it } from 'vitest';
import { fitImageDimensions } from './imageResize';

describe('fitImageDimensions', () => {
  it('resizes a landscape image by its longest edge', () => {
    expect(fitImageDimensions(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
  });

  it('resizes a portrait image by its longest edge', () => {
    expect(fitImageDimensions(1200, 3000, 2000)).toEqual({ width: 800, height: 2000 });
  });

  it('keeps square proportions', () => {
    expect(fitImageDimensions(3000, 3000, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it('does not enlarge an image that already fits', () => {
    expect(fitImageDimensions(600, 400, 2000)).toEqual({ width: 600, height: 400 });
  });

  it('rejects invalid dimensions', () => {
    expect(() => fitImageDimensions(0, 400, 2000)).toThrow(RangeError);
  });
});
