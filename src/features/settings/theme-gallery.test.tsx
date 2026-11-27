import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { paletteActions } from "@/features/palette/palette-actions";
import { startI18n } from "@/i18n";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { useTheme } from "@/theme/theme-context";
import { appThemes } from "@/theme/themes";
import { AppearanceSection } from "./general-sections";

let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  startI18n();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Painted() {
  const { theme, settings } = useTheme();
  return <p data-testid="painted">{`${theme.id}|${settings.theme}|${settings.lightTheme}|${settings.darkTheme}`}</p>;
}

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ThemeProvider>
        <AppearanceSection />
        <Painted />
      </ThemeProvider>,
    ),
  );
  const state = () => container.querySelector('[data-testid="painted"]')!.textContent;
  const cardSelector = '[role="radiogroup"][aria-label$=" themes"] [role="radio"]';
  const cards = () => container.querySelectorAll<HTMLButtonElement>(cardSelector);
  const card = (name: string) => [...cards()].find((b) => b.getAttribute("aria-label") === name)!;
  const followOff = () =>
    [...container.querySelectorAll<HTMLElement>('[aria-label="Follow system appearance"] [role="radio"]')].find(
      (b) => b.textContent === "Off",
    )!;
  return { container, state, card, cards, followOff };
}

// React derives enter and leave from over and out, which is what a real pointer sends.
const hover = (el: Element) =>
  act(() => void el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: document.body })));
const unhover = (el: Element) =>
  act(() => void el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body })));

const hexToRgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

describe("theme gallery", () => {
  it("shows every theme as a radio card, one checked per group while following the system", () => {
    const { cards } = render();
    expect(cards()).toHaveLength(13);
    expect([...cards()].filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Astra Light",
      "Astra Dark",
    ]);
  });

  it("paints each card's six ANSI colours and its accent, so dark themes differ at a glance", () => {
    const { card } = render();
    const swatches = (name: string) =>
      [...card(name).querySelectorAll<HTMLElement>("[data-swatches] > span")].map((s) => s.style.backgroundColor);
    const expected = (id: "nord" | "dracula") => {
      const { terminal: t, ui } = appThemes[id];
      return [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, ui.primary].map(hexToRgb);
    };
    expect(swatches("Nord")).toEqual(expected("nord"));
    expect(swatches("Dracula")).toEqual(expected("dracula"));
    expect(swatches("Nord")).not.toEqual(swatches("Dracula"));
  });

  it("previews a theme on hover across the window and restores it on leave without saving", () => {
    const { state, card } = render();
    const before = state();
    hover(card("Nord"));
    expect(state()!.startsWith("nord|")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--ui-ground")).toBe(appThemes.nord.ui.ground);
    unhover(card("Nord"));
    expect(state()).toBe(before);
  });

  it("sets the light or dark pick by the card's appearance while following the system", () => {
    const { state, card } = render();
    act(() => card("Dracula").click());
    expect(state()!.endsWith("|light|dracula")).toBe(true);
    act(() => card("GitHub Light").click());
    expect(state()!.endsWith("|githubLight|dracula")).toBe(true);
    expect(state()!.split("|")[1]).toBe("system");
  });

  it("pins the theme once following the system is off", () => {
    const { state, card, cards, followOff } = render();
    act(() => followOff().click());
    act(() => card("Gruvbox Dark").click());
    expect(state()!.startsWith("gruvboxDark|gruvboxDark|")).toBe(true);
    expect([...cards()].filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Gruvbox Dark",
    ]);
  });

  it("offers a palette action per theme", () => {
    render();
    const ids = paletteActions.list().map((a) => a.id);
    for (const id of Object.keys(appThemes)) expect(ids).toContain(`theme.${id}`);
    expect(paletteActions.list().find((a) => a.id === "theme.nord")?.title).toBe("Theme: Nord");
  });
});
