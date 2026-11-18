// @vitest-environment node
import { expect, it, vi } from "vitest";
import { getContrastRatio } from "../lib/ui-preferences.js";

const { readFileSync } = await vi.importActual<{
  readFileSync: (url: URL, encoding: "utf8") => string;
}>("node:fs");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

// jsdom leaves var() unresolved in computed border styles. Check declarations
// directly so colour tokens cannot overwrite DaisyUI's dimension/number tokens.
const themeBlocks = Array.from(css.matchAll(/@plugin "daisyui\/theme"\s*\{([^}]+)\}/g), ([, block]) => block);
const rawTokens = css.replace(/@plugin "daisyui\/theme"\s*\{[^}]+\}/g, "");

it("keeps the composer placeholder at AA contrast on the sunken pill in every palette", () => {
  const field = css.match(/\.sticker-composer-field\s*\{([^}]+)\}/)?.[1];
  const placeholder = css.match(/\.sticker-composer-field\s*>\s*textarea::placeholder\s*\{([^}]+)\}/)?.[1];
  expect(field).toMatch(/border-radius:\s*22px/);
  expect(field).toMatch(/background-color:\s*var\(--surface-sunken\)/);
  expect(placeholder).toMatch(/color:\s*var\(--text-muted\)/);
  expect(placeholder).toMatch(/opacity:\s*1\b/);

  const sunken = Array.from(rawTokens.matchAll(/--surface-sunken:\s*(#[0-9a-f]{6})/gi), ([, color]) => color);
  const muted = Array.from(rawTokens.matchAll(/--text-muted:\s*(#[0-9a-f]{6})/gi), ([, color]) => color);
  expect(sunken).toHaveLength(3);
  expect(muted).toHaveLength(sunken.length);
  for (const [index, background] of sunken.entries()) {
    expect(getContrastRatio(muted[index], background)).toBeGreaterThanOrEqual(4.5);
  }
});

it("scopes sticker hover fills to fine pointers and scales only the pressed artwork", () => {
  const hover = css.match(/@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*(\.sticker-strip[^{}]+,\s*\.sticker-tile:hover)\s*\{([^}]+)\}/);
  expect(hover?.[1]).toContain(':not([aria-selected="true"]):hover');
  expect(hover?.[2]).toMatch(/background:\s*var\(--surface-sunken\)/);
  expect(css.match(/\.sticker-tile:hover/g)).toHaveLength(1);
  expect(css).toMatch(/\.sticker-tile\[data-pressed\]\s*>\s*\.sticker-art\s*\{\s*transform:\s*scale\(/);
});

it("uses a background edge cue for overflowing bubble actions without reserving scrollbar width", () => {
  const strip = css.match(/\.call-bubble-actions\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(strip).toMatch(/scrollbar-width:\s*none/);
  expect(strip.match(/linear-gradient\(/g)).toHaveLength(2);
  expect(strip).toMatch(/background-attachment:\s*local,\s*scroll/);
  expect(strip).toMatch(/background-position:\s*bottom/);
});

it("raw design tokens do not collide with DaisyUI dimension or number variables", () => {
  const daisyVariables = new Set(themeBlocks.flatMap((block) =>
    Array.from(block.matchAll(/(--(?:border|radius-[\w-]+|size-[\w-]+|depth|noise))\s*:/g), ([, name]) => name),
  ));
  expect(daisyVariables.has("--border")).toBe(true);
  const collisions = Array.from(rawTokens.matchAll(/(--[\w-]+)\s*:/g), ([, name]) => name)
    .filter((name) => daisyVariables.has(name));
  expect(collisions).toEqual([]);
});

it.each(["light", "dark"])("%s keeps the line colour separate from DaisyUI's border width", (theme) => {
  const block = themeBlocks.find((block) => block.includes(`name: "${theme}"`));
  expect(block).toBeDefined();
  expect(block).toMatch(/--border:\s*1px\s*;/);
  expect(block).toMatch(/--color-base-300:\s*var\(--line\)\s*;/);
  expect(css).toMatch(/--color-line:\s*var\(--line\)\s*;/);
  const colours = Array.from(rawTokens.matchAll(/--line:\s*([^;]+);/g), ([, value]) => value.trim());
  // Default light, system dark and explicit dark palettes.
  expect(colours).toEqual(["#d5dde0", "#2a3b44", "#2a3b44"]);
});
