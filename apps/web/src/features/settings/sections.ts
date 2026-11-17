export const SETTINGS_SECTIONS = [
  ["profile", "settingsProfileSection", "user"], ["appearance", "settingsAppearanceSection", "palette"],
  ["attachments", "attachmentSettings", "attach"],
  ["notifications", "androidBackground.notificationsSection", "settings"],
  ["privacy", "settingsPrivacySection", "lock"],
  ["security", "settingsSecuritySection", "key"], ["devices", "linkedDevices", "devices"],
  ["about", "updates.about", "info"],
  ["emoji", "customEmoji", "emoji"], ["account", "settingsAccountSection", "user"],
] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number][0];

