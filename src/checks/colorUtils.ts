/**
 * WCAG 2.1 contrast math + a small color-space toolkit used to compute
 * both the measured contrast ratio and a concrete suggested fix color.
 * Reference: https://www.w3.org/TR/WCAG21/#contrast-minimum
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses `rgb(...)` / `rgba(...)` as returned by getComputedStyle. Falls back to opaque black. */
export function parseColor(value: string): RGBA {
  const m = value.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i,
  );
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) - 1 (white). */
export function relativeLuminance({ r, g, b }: RGBA): number {
  return (
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
  );
}

/** WCAG contrast ratio between two colors, range 1 (identical) - 21 (black/white). */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Flattens a translucent foreground color onto an opaque background (simple alpha compositing). */
export function compositeOver(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

export function toHex({ r, g, b }: RGBA): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Finds the smallest lightness adjustment to `fg` (darkening or lightening,
 * whichever direction is available) that reaches `targetRatio` against `bg`.
 * Returns null if even pure black/white against bg can't reach the target
 * (i.e. bg itself is too close to mid-gray at extremes -- vanishingly rare).
 */
export function suggestAccessibleColor(
  fg: RGBA,
  bg: RGBA,
  targetRatio: number,
): string | null {
  const { h, s, l } = rgbToHsl(fg.r, fg.g, fg.b);
  const bgLum = relativeLuminance(bg);
  // Decide direction: if the background is light, darkening fg reaches higher
  // contrast fastest; if background is dark, lighten fg.
  const darken = bgLum > 0.5;

  for (let steps = 0; steps <= 100; steps++) {
    const l2 = darken ? Math.max(0, l - steps / 100) : Math.min(1, l + steps / 100);
    const candidate = hslToRgb(h, s, l2);
    if (contrastRatio(candidate, bg) >= targetRatio) {
      return toHex(candidate);
    }
  }

  // Direction guess failed (unusual bg); try pure black and white as a last resort.
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  if (contrastRatio(black, bg) >= targetRatio) return toHex(black);
  if (contrastRatio(white, bg) >= targetRatio) return toHex(white);
  return null;
}

/** WCAG "large text" threshold: >=24px, or >=18.66px (14pt) when bold (>=700). */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  if (fontSizePx >= 24) return true;
  if (fontSizePx >= 18.66 && fontWeight >= 700) return true;
  return false;
}
