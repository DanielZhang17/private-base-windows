import { queryClient } from "../lib/query-client.js";
import { useCallStore } from "../stores/callStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { usePresenceStore } from "../stores/presenceStore.js";
import { stopAllCapturedTracks } from "./media.js";
import { registerAccountScopedCleanup } from "./session-cleanup.js";

/**
 * Drop everything in memory that belongs to the signed-in account. Leaving a session through
 * router navigation keeps the JS heap alive, unlike the full page load it replaced, so the
 * next account to sign in would otherwise see the previous one's cached conversations and
 * plaintext previews, and an active call would keep capturing the camera and microphone.
 */
export function clearAccountScopedState(): void {
  const steps = [
    // Stops the tracks in the local stream and clears the active call.
    () => useCallStore.getState().clearCall(),
    // Tracks held outside the local stream, such as the camera during a screen share.
    stopAllCapturedTracks,
    () => queryClient.clear(),
    () => useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: new Map(),
      drafts: new Map(),
      typingUsers: new Map(),
      unreadCounts: new Map(),
      outgoingRemovalNotices: new Set(),
    }),
    () => usePresenceStore.setState({ onlineUsers: new Set() }),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      // One failing cleanup must not leave the remaining account data behind.
      console.error("Failed to clear account state", error);
    }
  }
}

registerAccountScopedCleanup(clearAccountScopedState);
