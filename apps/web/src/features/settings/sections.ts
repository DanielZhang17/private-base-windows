export const SETTINGS_SECTIONS = [
  ["profile", "settingsProfileSection", "user"], ["appearance", "settingsAppearanceSection", "palette"],
  ["attachments", "attachmentSettings", "attach"],
  ["security", "settingsSecuritySection", "key"], ["devices", "linkedDevices", "devices"],
  ["emoji", "customEmoji", "emoji"], ["account", "settingsAccountSection", "user"],
] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number][0];

