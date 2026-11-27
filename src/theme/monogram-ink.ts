import type { AppTheme } from "./themes";

/** The ANSI hues a Host's monogram can take. */
export const ansiHues = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
export type AnsiHue = (typeof ansiHues)[number];

/** How much of the hue a monogram tile tints over whatever lies under it (`bg-ansi-*\/15`). */
export const tileAlpha = 0.15;
/** The text contrast a monogram aims for; WCAG AA is 4.5, the rest is margin for rounding. */
const inkContrast = 4.6;

type Rgb = readonly [number, number, number];

const parse = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
const format = (rgb: Rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
/** `a` and `b` blended in sRGB; `share` is how much of `a` there is. */
const blend = (a: Rgb, b: Rgb, share: number): Rgb => [0, 1, 2].map((i) => a[i]! * share + b[i]! * (1 - share)) as unknown as Rgb;

/** WCAG relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every colour a monogram tile sits on: Home's cards (the ground), the Host list (the sidebar,
 * and `--selected` over it), the palette's menu (raised), and a hovered or highlighted row
 * (`--accent`), as `src/index.css` derives them.
 */
export function tileBackings(theme: AppTheme): string[] {
  const { ground, sidebar, raised, foreground, primary } = theme.ui;
  const over = (top: string, alpha: number, under: string) => format(blend(parse(top), parse(under), alpha));
  return [ground, sidebar, raised, over(foreground, 0.09, ground), over(primary, 0.14, sidebar)];
}

/** The tile fill (the hue at `tileAlpha`) over `backing`. */
export function tileFill(theme: AppTheme, hue: AnsiHue, backing: string): string {
  return format(blend(parse(theme.terminal[hue]), parse(backing), tileAlpha));
}

/** The least of the hue the letters keep; below it they would just be the text colour. */
const minHueShare = 0.3;
/** The ends the letters can be pushed towards when the theme's text colour is too dull to lift the hue. */
const black: Rgb = [0, 0, 0];
const white: Rgb = [255, 255, 255];

/**
 * The colour of a monogram's letters. The bare ANSI hue is too faint against its own tint in many
 * themes, so the letters take as much of the hue as still reads at AA on every tile and the rest
 * from the theme's text colour. Where even that is too dull (Solarized's), the text colour is first
 * pushed towards black on a light theme, white on a dark one, only as far as it takes.
 */
export function monogramInk(theme: AppTheme, hue: AnsiHue): string {
  const hueRgb = parse(theme.terminal[hue]);
  const text = parse(theme.ui.foreground);
  const end = theme.appearance === "dark" ? white : black;
  const fills = tileBackings(theme).map((backing) => tileFill(theme, hue, backing));
  for (let push = 0; push <= 1; push += 0.1) {
    const pole = blend(end, text, push);
    for (let share = 1; share >= minHueShare; share -= 0.05) {
      const ink = format(blend(hueRgb, pole, share));
      if (fills.every((fill) => contrast(ink, fill) >= inkContrast)) return ink;
    }
  }
  return format(end);
}
