import { expect, it } from "vitest";
import { setLocalePreference } from "../../i18n/index.js";
import { formatMegabytes } from "../../i18n/format.js";
import { checksumGroups, processorLabel, verifyCommand } from "./format.js";

it("formats sizes as decimal megabytes with one decimal in the app language", async () => {
  expect(formatMegabytes(4764074)).toBe("4.8 MB");
  expect(formatMegabytes(15156916)).toBe("15.2 MB");
  await setLocalePreference("de");
  expect(formatMegabytes(4405594)).toBe("4,4 MB");
});

it("names known processors and passes unknown ones through", () => {
  expect(processorLabel("macos", "arm64")).toEqual({ key: "clients.archAppleSilicon" });
  expect(processorLabel("windows", "x64")).toEqual({ key: "clients.archX64" });
  expect(processorLabel("android", "arm64")).toEqual({ key: "clients.archArm64" });
  expect(processorLabel("macos", "x86_64")).toEqual({ raw: "x86_64" });
  expect(processorLabel("windows", "arm64")).toEqual({ raw: "arm64" });
});

it("splits the checksum into 8 groups of 8", () => {
  const groups = checksumGroups("9B6B13C4453B015543D71443C0F302535F2CBF0B2FE54D4DED3FEAF20F31CCA8");
  expect(groups).toHaveLength(8);
  expect(groups.every((group) => group.length === 8)).toBe(true);
  expect(groups.join("")).toBe("9b6b13c4453b015543d71443c0f302535f2cbf0b2fe54d4ded3feaf20f31cca8");
});

it("builds platform verify commands", () => {
  expect(verifyCommand("macos", "a.dmg")).toBe("shasum -a 256 ~/Downloads/a.dmg");
  expect(verifyCommand("windows", "a.exe")).toBe("Get-FileHash ~\\Downloads\\a.exe");
  expect(verifyCommand("android", "a.apk")).toBeNull();
});
