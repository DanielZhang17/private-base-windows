/** Test fixture only. */
// Real latest.json content (2026-11-16).
export const LATEST = {
  product: "Private Base",
  version: "0.0.1-20261115",
  published: "2026-11-17T05:10:53Z",
  platforms: {
    macos: {
      file: "PrivateBase-0.0.1-20261115-macos-arm64.dmg",
      url: "https://dist.718788.xyz/private-base/releases/0.0.1-20261115/PrivateBase-0.0.1-20261115-macos-arm64.dmg",
      size: 4764074,
      sha256: "9b6b13c4453b015543d71443c0f302535f2cbf0b2fe54d4ded3feaf20f31cca8",
      arch: "arm64", minOs: "macOS 12.3", signed: "Apple Development (not notarized)",
    },
    android: {
      file: "PrivateBase-0.0.1-20261115-android-arm64.apk",
      url: "https://dist.718788.xyz/private-base/releases/0.0.1-20261115/PrivateBase-0.0.1-20261115-android-arm64.apk",
      size: 15156916,
      sha256: "14ea21501acab132530385b3f351aae88971bf7c0b7db44d80479541e984a7a1",
      arch: "arm64", minOs: "Android 7.0", signed: "debug key",
    },
    windows: {
      file: "PrivateBase-0.0.1-20261115-windows-x64-setup.exe",
      url: "https://dist.718788.xyz/private-base/releases/0.0.1-20261115/PrivateBase-0.0.1-20261115-windows-x64-setup.exe",
      size: 4405594,
      sha256: "337f82c3dc4b735c875f743dc931238dd04c25055db5a40be9c24022c979adeb",
      arch: "x64", minOs: "Windows 10", signed: "unsigned debug build",
    },
    ios: null,
  },
};
