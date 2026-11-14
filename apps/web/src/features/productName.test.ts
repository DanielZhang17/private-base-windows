import { expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import manifestJson from "../../public/manifest.webmanifest?raw";
import loginPage from "../pages/LoginPage.tsx?raw";
import registerPage from "../pages/RegisterPage.tsx?raw";
import unlockPage from "../pages/UnlockPage.tsx?raw";

it("uses Private Base for the document and installed app names", () => {
  const html = new DOMParser().parseFromString(indexHtml, "text/html");
  expect(html.title).toBe("Private Base");
  expect(html.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")).toBe("Private Base");
  expect(JSON.parse(manifestJson)).toMatchObject({ name: "Private Base", short_name: "Private Base" });
});

it.each([loginPage, registerPage, unlockPage])("uses Private Base in authentication page copy %#", (page) => {
  expect(page).toContain("Private Base");
  expect(page).not.toContain("E2EE Chat");
});
