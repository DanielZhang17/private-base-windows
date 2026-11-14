import { expect, it } from "vitest";
import { initializeLocale, setLocalePreference } from "./index.js";

it("sets the default title at initialization and leaves route titles intact on locale changes", async () => {
  await initializeLocale();
  expect(document.title).toBe("Private Base");
  document.title = "Alice · Private Base";
  await setLocalePreference("fr");
  expect(document.documentElement.lang).toBe("fr");
  expect(document.title).toBe("Alice · Private Base");
});
