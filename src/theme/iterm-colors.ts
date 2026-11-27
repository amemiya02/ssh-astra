import type { ITheme } from "@xterm/xterm";
import { isPlistDictionary, parsePlist, type PlistValue } from "rork-plist";
import { ansiColorKeys } from "./themes";

export const maxItermColorsKiB = 64;
export const requiredPaletteKeys = ["background", "foreground", "cursor", "cursorAccent", ...ansiColorKeys] as const;
export type ItermPalette = Record<(typeof requiredPaletteKeys)[number], string> &
  Pick<ITheme, "selectionBackground" | "selectionForeground">;

const rgbChannels = ["Red Component", "Green Component", "Blue Component"];

function colorComponent(value: PlistValue | undefined): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

function hexByte(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
}

/** Display P3 and sRGB share a transfer curve and a D65 white point. */
function displayP3ToSrgb(channels: [number, number, number]): number[] {
  const linearize = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const encode = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  const [red, green, blue] = [linearize(channels[0]), linearize(channels[1]), linearize(channels[2])] as const;
  // Combine the P3-to-XYZ and XYZ-to-sRGB matrices from CSS Color 4, §19.
  return [
    1.22494 * red - 0.22494 * green,
    -0.042057 * red + 1.042057 * green,
    -0.019638 * red - 0.078636 * green + 1.098274 * blue,
  ].map(encode);
}

function color(value: PlistValue | undefined, keepAlpha = false): string | undefined {
  if (!isPlistDictionary(value)) return undefined;
  const [red, green, blue] = rgbChannels.map((key) => colorComponent(value[key]));
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  const rgb: [number, number, number] = [red, green, blue];
  const channels = value["Color Space"] === "P3" ? displayP3ToSrgb(rgb) : rgb;
  const alpha = keepAlpha ? colorComponent(value["Alpha Component"]) : undefined;
  if (alpha !== undefined && alpha < 1) channels.push(alpha);
  return `#${channels.map(hexByte).join("")}`;
}

/** Reads one Terminal palette from an iTerm2 property list, including current binary exports. */
export function parseItermColors(input: string | Uint8Array): ItermPalette | undefined {
  const size = typeof input === "string" ? input.length : input.byteLength;
  if (size > maxItermColorsKiB * 1024) return undefined;

  let colors: PlistValue;
  try {
    colors = parsePlist(input, { maxDepth: 4, data: "view" });
  } catch {
    return undefined;
  }
  if (!isPlistDictionary(colors)) return undefined;

  // Multi-mode exports include unsuffixed colours from the active mode.
  const background = color(colors["Background Color"]);
  const foreground = color(colors["Foreground Color"]);
  if (!background || !foreground) return undefined;

  const ansi = ansiColorKeys.map((key, index) => [key, color(colors[`Ansi ${index} Color`])] as const);
  if (ansi.some(([, value]) => value === undefined)) return undefined;
  const selectionBackground = color(colors["Selection Color"], true);
  const selectionForeground = color(colors["Selected Text Color"]);
  return {
    ...Object.fromEntries(ansi) as Record<(typeof ansiColorKeys)[number], string>,
    background,
    foreground,
    cursor: color(colors["Cursor Color"]) ?? foreground,
    cursorAccent: color(colors["Cursor Text Color"]) ?? background,
    ...(selectionBackground && { selectionBackground }),
    ...(selectionForeground && { selectionForeground }),
  };
}
