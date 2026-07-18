import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface PixelDiffResult {
  /** PNG buffer, same dimensions as the inputs, red where pixels differ. */
  diffPng: Buffer;
  width: number;
  height: number;
  diffPixelCount: number;
  totalPixels: number;
  /** 0 = identical, 1 = completely different. */
  diffRatio: number;
  /** True if the two screenshots had to be cropped to a common size before diffing. */
  dimensionsMismatched: boolean;
}

/**
 * Pixel-level visual diff between two full-page screenshots. Playwright's
 * full-page screenshots can differ in height when content length changes
 * between "before" and "after", so we diff over the overlapping region
 * (top-left aligned) and flag the mismatch rather than failing outright --
 * a redesign that adds content shouldn't crash the tool.
 */
export function diffScreenshots(beforePng: Buffer, afterPng: Buffer): PixelDiffResult {
  const before = PNG.sync.read(beforePng);
  const after = PNG.sync.read(afterPng);

  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const dimensionsMismatched = before.width !== after.width || before.height !== after.height;

  const beforeCropped = crop(before, width, height);
  const afterCropped = crop(after, width, height);
  const diff = new PNG({ width, height });

  const diffPixelCount = pixelmatch(
    beforeCropped.data,
    afterCropped.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 },
  );

  return {
    diffPng: PNG.sync.write(diff),
    width,
    height,
    diffPixelCount,
    totalPixels: width * height,
    diffRatio: width * height > 0 ? diffPixelCount / (width * height) : 0,
    dimensionsMismatched,
  };
}

function crop(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
  return out;
}
