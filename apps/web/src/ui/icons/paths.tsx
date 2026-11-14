import type { ReactNode } from "react";

/**
 * Icon set. Every icon is drawn on a 24×24 grid with a 1.75px stroke, round caps
 * and joins, and no fills (dots are short strokes). Add new icons here in the
 * same style rather than pasting SVG into pages.
 */
export const ICON_PATHS = {
  // Navigation
  "chevron-left": <path d="M15 5l-7 7 7 7" />,
  "chevron-right": <path d="M9 5l7 7-7 7" />,
  "chevron-down": <path d="M5 9l7 7 7-7" />,
  "arrow-left": <path d="M20 12H4m6-7l-7 7 7 7" />,
  "arrow-down": <path d="M12 4v16m-7-6l7 7 7-7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={2.5} />,
  "more-vertical": <path d="M12 5v.01M12 12v.01M12 19v.01" strokeWidth={2.5} />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>,

  // Sections
  chats: <path d="M20 11.5a7.5 7.5 0 01-11 6.63L4 19.5l1.4-4.2A7.5 7.5 0 1120 11.5z" />,
  settings: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0114 0" /></>,
  users: <><circle cx="9" cy="8.5" r="3" /><path d="M3 19.5a6 6 0 0112 0" /><path d="M15.5 5.8a3 3 0 010 5.4M17.5 14.2a6 6 0 013.5 5.3" /></>,
  "user-plus": <><circle cx="10" cy="8" r="3.5" /><path d="M3 20a7 7 0 0114 0" /><path d="M19 8v6m-3-3h6" /></>,
  devices: <><rect x="3" y="5" width="13" height="10" rx="1.5" /><path d="M2 18h9" /><rect x="15" y="9" width="6" height="11" rx="1.5" /></>,
  "device-phone": <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17.5h2" /></>,
  "device-desktop": <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6m-3-4v4" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 100 17c1.2 0 1.8-.9 1.8-1.8 0-1.6 1-2.2 2.2-2.2h1.5a3 3 0 003-3c0-5.5-3.8-10-8.5-10z" /><path d="M8 10.5v.01M12 7.5v.01M16 10.5v.01" strokeWidth={2.5} /></>,
  bell: <><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16z" /><path d="M10 20.5a2.2 2.2 0 004 0" /></>,

  // Composer and messages
  send: <path d="M4.5 12L4 4.5 20.5 12 4 19.5l.5-7.5zm0 0h7" />,
  attach: <path d="M19.5 11.5l-7.6 7.6a4.5 4.5 0 01-6.4-6.4l8.3-8.3a3 3 0 014.3 4.3l-8.2 8.2a1.5 1.5 0 01-2.2-2.1l7.5-7.5" />,
  emoji: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14a4.2 4.2 0 007 0" /><path d="M9 9.5v.01M15 9.5v.01" strokeWidth={2.5} /></>,
  file: <><path d="M13.5 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8.5L13.5 3z" /><path d="M13.5 3v5.5H19" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5" /></>,
  download: <path d="M12 4v11m-5-4.5l5 5 5-5M5 20h14" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="12" rx="2" /><path d="M15.5 8.5V6a2 2 0 00-2-2H6.5a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  "check-double": <path d="M2.5 12.5l4.5 4.5 9-9.5M12 15.5l1.5 1.5 9-9.5" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  timer: <><circle cx="12" cy="13.5" r="7.5" /><path d="M12 9.5v4M9.5 3h5M12 3v3" /></>,
  retry: <><path d="M19.5 12a7.5 7.5 0 11-2.4-5.5" /><path d="M19.5 4v4h-4" /></>,
  trash: <><path d="M4.5 7h15M10 3.5h4M6.5 7l.8 12a1.5 1.5 0 001.5 1.5h6.4a1.5 1.5 0 001.5-1.5l.8-12" /><path d="M10 11v5.5M14 11v5.5" /></>,

  // Calls
  phone: <path d="M5.5 3.5h3l1.5 4.5-2 1.5a12 12 0 006.5 6.5l1.5-2 4.5 1.5v3a2 2 0 01-2 2A16 16 0 013.5 5.5a2 2 0 012-2z" />,
  "phone-off": <><path d="M3 15.5c5-5 13-5 18 0l-1.8 2.8-4-1.2-.4-2.6a9 9 0 00-5.6 0l-.4 2.6-4 1.2L3 15.5z" /></>,
  video: <><rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="M15.5 10.5l5-3v9l-5-3" /></>,
  "video-off": <><path d="M9 6.5h4.5a2 2 0 012 2v2l5-3v9l-3.2-1.9M15.5 15.5a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2" /><path d="M4 4l16 16" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" /></>,
  "mic-off": <><path d="M15 10V6a3 3 0 00-5.7-1.3M9 9v2a3 3 0 004.6 2.5" /><path d="M18.5 11.5a6.5 6.5 0 01-.8 3M5.5 11.5a6.5 6.5 0 0010 5.5M12 18v3M4 4l16 16" /></>,
  speaker: <><path d="M4 9.5h3l5-4v13l-5-4H4v-5z" /><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" /></>,

  // Security and status
  "shield-check": <><path d="M12 3l7.5 2.8v5.7c0 4.3-3 7.8-7.5 9.5-4.5-1.7-7.5-5.2-7.5-9.5V5.8L12 3z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  shield: <path d="M12 3l7.5 2.8v5.7c0 4.3-3 7.8-7.5 9.5-4.5-1.7-7.5-5.2-7.5-9.5V5.8L12 3z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8.5-8.5M16 7l2.5 2.5M13.5 9.5l2 2" /></>,
  passkey: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6.5 6.5 0 019.5-5.8" /><circle cx="17.5" cy="13.5" r="2.5" /><path d="M17.5 16v5l1.5-1.5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 017.5-2" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  "eye-off": <><path d="M9.5 5.9A8.5 8.5 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a15 15 0 01-2.6 3.3M6.2 7.7A15 15 0 002.5 12S6 18.5 12 18.5a8.5 8.5 0 004-1" /><path d="M4 4l16 16" /></>,
  alert: <><path d="M12 4L2.8 19.5h18.4L12 4z" /><path d="M12 10v4.5" /><path d="M12 17v.01" strokeWidth={2.5} /></>,
  "alert-circle": <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5" /><path d="M12 16v.01" strokeWidth={2.5} /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><path d="M12 7.8v.01" strokeWidth={2.5} /></>,
  "check-circle": <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.5 2.5 4.5-5" /></>,
  offline: <><path d="M3 9.5a13 13 0 014.5-2.8M11 5.6a13 13 0 0110 3.9M6.5 13a8 8 0 013.8-2M14.5 11.3a8 8 0 013 1.7" /><path d="M12 17.5v.01" strokeWidth={2.5} /><path d="M4 4l16 16" /></>,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  logout: <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" />,
  camera: <><path d="M4 8.5a2 2 0 012-2h1.5l1.5-2h6l1.5 2H18a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2v-9z" /><circle cx="12" cy="13" r="3.5" /></>,

  // Theme
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
