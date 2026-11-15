import { capabilities } from "./capabilities.js";
import { invoke } from "@tauri-apps/api/core";

export interface BackgroundStatus {
  running: boolean;
  notifications: boolean;
  fullScreen: boolean;
  batteryExempt: boolean;
}
export interface NotificationAction {
  kind: "accept" | "decline" | "open-conversation";
  id: string;
}
export const validNotificationId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args);
}

export async function configureBackground(enabled: boolean): Promise<void> {
  if (!capabilities.backgroundConnection) return;
  await command("configure_background", { enabled });
}
export async function backgroundStatus(): Promise<BackgroundStatus> {
  if (!capabilities.backgroundConnection) throw new Error("unavailable");
  return command("background_status");
}
export async function openBackgroundSettings(setting: "battery" | "fullScreen"): Promise<void> {
  if (!capabilities.backgroundConnection) return;
  await command("open_background_settings", { setting });
}
export async function showIncomingCall(call: { callId: string; callerName: string; video: boolean }): Promise<boolean> {
  if (!capabilities.nativeCallNotifications || !validNotificationId(call.callId)) return false;
  return command("show_incoming_call", { callId: call.callId, callerName: call.callerName, video: call.video });
}
export async function cancelIncomingCall(callId: string): Promise<void> {
  if (!capabilities.nativeCallNotifications || !validNotificationId(callId)) return;
  await command("cancel_incoming_call", { callId });
}
export async function showMessageNotification(conversationId: string, senderName: string): Promise<boolean> {
  if (!capabilities.nativeCallNotifications || !validNotificationId(conversationId)) return false;
  return command("show_message_notification", { conversationId, senderName });
}
export async function takeNotificationActions(): Promise<NotificationAction[]> {
  if (!capabilities.nativeCallNotifications) return [];
  const actions = await command<NotificationAction[]>("take_notification_actions");
  return actions.filter((action) => action && typeof action.id === "string" && validNotificationId(action.id) &&
    ["accept", "decline", "open-conversation"].includes(action.kind));
}
