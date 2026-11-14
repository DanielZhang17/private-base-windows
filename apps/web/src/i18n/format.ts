import { getLocale } from "./index.js";
export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(value);
}
export function formatTime(value: number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return formatDate(value, { hour: "2-digit", minute: "2-digit", ...options });
}
export function formatDateTime(value: number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return formatDate(value, { dateStyle: "short", timeStyle: "medium", ...options });
}
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options: Intl.RelativeTimeFormatOptions = {}): string {
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", ...options }).format(value, unit);
}
export function formatRelativeTimestamp(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return formatRelativeTime(0, "second");
  const [unit, divisor] = abs < 3600 ? ["minute", 60] as const : abs < 86400 ? ["hour", 3600] as const : ["day", 86400] as const;
  return formatRelativeTime(Math.trunc(seconds / divisor), unit);
}
export function formatDuration(seconds: number): string {
  const [unit, divisor] = seconds >= 86400 ? ["day", 86400] as const : seconds >= 3600 ? ["hour", 3600] as const : ["minute", 60] as const;
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "short" }).format(Math.round(seconds / divisor));
}
