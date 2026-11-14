import { expect, it } from "vitest";
import { DarkSurface } from "./index.js";
import { setupDom } from "./test-utils.js";
const { render, container } = setupDom();
it("scopes the call's dark theme without changing a forced light app", async () => {
  document.documentElement.dataset.theme = "light";
  await render(<DarkSurface aria-label="Call" className="fixed inset-0">Call content</DarkSurface>);
  const layer = container().querySelector("section")!;
  expect(layer.dataset.theme).toBe("dark");
  expect(layer.className).toContain("ui-dark-surface");
  expect(document.documentElement.dataset.theme).toBe("light");
  delete document.documentElement.dataset.theme;
});
