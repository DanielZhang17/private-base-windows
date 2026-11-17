import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { translateError, toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useSendMessage } from "./useSendMessage.js";
import { useFeedback } from "../shared/useFeedback.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CALL_KEY_RECOVERY_TTL_MS,
  CALL_RING_TIMEOUT_MS,
  type ConversationWithMembers,
  type DecryptedMessage,
  type InitiateCallResponse,
} from "@e2ee-chat/shared";
import { toBase64Url } from "@e2ee-chat/crypto";
import { api } from "../../services/api.js";
import { cleanupCallBestEffort } from "../../services/call-cleanup.js";
import { createChatWebSocket } from "../../services/ws.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useConnectionStore } from "../../stores/connectionStore.js";
import { usePresenceStore } from "../../stores/presenceStore.js";

import { guardMessageForPublish, deletePendingCall, getPendingCall, saveMessage, savePendingCall } from "../../db/index.js";
import { sendDirectPayloadFanout } from "../../lib/direct-messages.js";
import { upsertConversationInCache, refreshConversationList } from "../../lib/conversation-cache.js";
import {
  ingestMessageFrame,
  handleMessageDeletion,
  loadOlderPersistedConversationMessages,
  loadPersistedConversationMessages,
  syncConversationMessages,
} from "../../lib/message-sync.js";

import { supportsE2EECalling } from "../../services/webrtc.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";

function persistMessage(message: DecryptedMessage): Promise<void> {
  return saveMessage({
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    expiresAt: message.expiresAt,
    expiryKind: message.expiryKind,
    status: message.status,
    deletedAt: message.deletedAt,
    deletedByUserId: message.deletedByUserId,
  });
}

function getConversationName(conversation: ConversationWithMembers | undefined, localUserId: string | undefined): string {
  if (!conversation) return t("conversationLoadingStatus");
  if (conversation.name) return conversation.name;
  if (!localUserId) {
    return conversation.type === "direct" ? t("directMessage") : t("groupChat");
  }
  return conversation.members
    .filter((member) => member.userId !== localUserId)
    .map((member) => member.user.displayName)
    .join(", ") || t("chatNameFallback");
}

function getDirectPeer(conversation: ConversationWithMembers | undefined, localUserId: string | undefined) {
  if (!conversation || conversation.type !== "direct" || !localUserId) return null;
  return conversation.members.find((member) => member.userId !== localUserId) ?? null;
}

export function useConversation() {
  useLocale();
  const { pendingConfirmation, notice, noticeMessage, setNotice, requestConfirmation, dismissNotice } = useFeedback();
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const messages = useChatStore((state) => state.messages);
  const outgoingRemoved = useChatStore((state) => !!conversationId && state.outgoingRemovalNotices.has(conversationId));
  const dismissOutgoingRemoval = () => {
    if (conversationId) useChatStore.getState().dismissOutgoingRemovalNotice(conversationId);
  };
  const addMessage = useChatStore((state) => state.addMessage);
  const setActiveConversation = useChatStore((state) => state.setActiveConversation);
  const updateMessageStatus = useChatStore((state) => state.updateMessageStatus);
  const setConnection = useConnectionStore((state) => state.setConnection);
  const removeConnection = useConnectionStore((state) => state.removeConnection);
  const setOutgoingCall = useCallStore((state) => state.setOutgoingCall);
  const activeCallId = useCallStore((state) => state.activeCallId);
  const activeCallStatus = useCallStore((state) => state.callStatus);
  const messageListRef = useRef<HTMLDivElement>(null);
  const pendingInitialScrollRef = useRef(true);
  const shouldStickToBottomRef = useRef(true);
  const previousLastMessageIdRef = useRef<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newMessagesBelowCount, setNewMessagesBelowCount] = useState(0);
  const startingCallTokenRef = useRef<symbol | null>(null);
  const [startingCallType, setStartingCallType] = useState<"audio" | "video" | null>(null);
  const [callError, setCallError] = useState<LocalizedMessage | null>(null);
  const [callUnsupported, setCallUnsupported] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [showRenameGroup, setShowRenameGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroup, setRenamingGroup] = useState(false);
  const [updatingInvitePolicy, setUpdatingInvitePolicy] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [hasOlderCachedMessages, setHasOlderCachedMessages] = useState(false);
  const [loadingOlderCachedMessages, setLoadingOlderCachedMessages] = useState(false);
  const queryClient = useQueryClient();
  const conversationEpoch = useRef(0);
  const scrollFrame = useRef<number | null>(null);

  const handleUpdateInvitePolicy = async (policy: "any_member" | "admins_only") => {
    if (!conversationId) return;
    setUpdatingInvitePolicy(true);
    try {
      await api.patch(`/api/conversations/${conversationId}`, { invitePolicy: policy });
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await refreshConversationList();
    } catch (error: any) {
      setNotice(toErrorMessage(error, "failedToUpdateInvitePolicy"));
    } finally {
      setUpdatingInvitePolicy(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!conversationId) return;
    if (!await requestConfirmation(localized("areYouSureYouWantToRemoveThis"))) return;
    try {
      await api.delete(`/api/conversations/${conversationId}/members/${memberId}`);
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await refreshConversationList();
    } catch (err: any) {
      setNotice(toErrorMessage(err, "failedToRemoveMember"));
    }
  };

  const { data: conversation, isLoading: conversationLoading, error: conversationError } = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.get<ConversationWithMembers>(`/api/conversations/${conversationId}`),
    enabled: !!conversationId,
  });

  useEffect(() => {
    if (conversation) {
      upsertConversationInCache(conversation);
    }
  }, [conversation]);

  const clearUnread = useChatStore((s) => s.clearUnread);

  useEffect(() => {
    if (!conversationId) return;
    conversationEpoch.current += 1;
    setActiveConversation(conversationId);
    clearUnread(conversationId);
    pendingInitialScrollRef.current = true;
    shouldStickToBottomRef.current = true;
    previousLastMessageIdRef.current = null;

    let cancelled = false;
    void (async () => {
      try {
        const persisted = await loadPersistedConversationMessages(conversationId);
        if (!cancelled) {
          setHasOlderCachedMessages(persisted.hasOlder);
        }
        await syncConversationMessages(conversationId);
      } catch (error) {
        console.error("Failed to initialize conversation messages", error);
      }
    })();

    const handleMessagesScroll = () => {
      const viewport = messageListRef.current;
      if (!viewport) return;
      const distanceFromBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      shouldStickToBottomRef.current = distanceFromBottom < 80;
      setShowScrollToBottom(distanceFromBottom > 200);
      if (distanceFromBottom < 80) {
        setNewMessagesBelowCount(0);
      }
    };

    const viewport = messageListRef.current;
    viewport?.addEventListener("scroll", handleMessagesScroll, { passive: true });

    return () => {
      cancelled = true;
      conversationEpoch.current += 1;
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
      viewport?.removeEventListener("scroll", handleMessagesScroll);
      setHasOlderCachedMessages(false);
      setLoadingOlderCachedMessages(false);
      setActiveConversation(null);
    };
  }, [conversationId, setActiveConversation, clearUnread]);

  useEffect(() => {
    if (!conversationId) return;

    let ws: WebSocket;
    let disposed = false;
    const session = useAuthStore.getState();
    try {
      ws = createChatWebSocket(conversationId, (frame) => {
        if (frame.type === "message") {
          void ingestMessageFrame({ ...frame, conversationId });
          return;
        }
        if (frame.type === "message_event") {
          void handleMessageDeletion(frame.payload);
          return;
        }
        if (frame.type === "typing") {
          useChatStore.getState().setTyping(conversationId, frame.userId, frame.isTyping);
          return;
        }
        if (frame.type === "ack") {
          const existingMessages = useChatStore.getState().messages.get(conversationId) ?? [];
          const existing = existingMessages.find((message) => message.id === frame.messageId);
          if (existing) {
            const normalizedMessage: DecryptedMessage = {
              ...existing,
              timestamp: frame.serverTimestamp,
              status: "sent",
            };
            void guardMessageForPublish(normalizedMessage).then((visible) => {
              const current = useAuthStore.getState();
              if (disposed || current.user?.id !== session.user?.id || current.device?.id !== session.device?.id || current.sessionId !== session.sessionId) return;
              if (visible) { addMessage(conversationId, visible); void persistMessage(visible); }
              else useChatStore.getState().removeMessages([frame.messageId]);
            }).catch(() => undefined);
          } else {
            updateMessageStatus(frame.messageId, "sent");
          }
        }
      }, () => {
        if (useConnectionStore.getState().wsConnections.get(conversationId) === ws) removeConnection(conversationId);
      });
    } catch (err) {
      console.error("Failed to open websocket:", err);
      return;
    }

    setConnection(conversationId, ws);
    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "typing", isTyping: false }));
      disposed = true;
      ws.close();
      if (useConnectionStore.getState().wsConnections.get(conversationId) === ws) removeConnection(conversationId);
    };
  }, [conversationId, removeConnection, setConnection, updateMessageStatus]);

  const conversationMessages = conversationId ? messages.get(conversationId) || [] : [];
  const typingUsers = useChatStore((state) => conversationId ? state.typingUsers.get(conversationId) : undefined);
  const typingNames = useMemo(() => {
    if (!typingUsers || typingUsers.size === 0 || !conversation) return null;
    return [...typingUsers]
      .filter((uid) => uid !== user?.id)
      .map((uid) => conversation.members.find((m) => m.userId === uid)?.user.displayName ?? t("typingUserFallback"));
  }, [typingUsers, conversation, user?.id]);
  const typingTimerRef = useRef<number | null>(null);

  const sendTypingIndicator = (isTyping: boolean) => {
    if (!conversationId) return;
    const ws = useConnectionStore.getState().wsConnections.get(conversationId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "typing", isTyping }));
    }
  };

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    };
  }, [conversationId]);

  const handleTyping = () => {
    sendTypingIndicator(true);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      sendTypingIndicator(false);
      typingTimerRef.current = null;
    }, 3000);
  };

  const conversationName = getConversationName(conversation, user?.id);
  const directPeer = useMemo(
    () => getDirectPeer(conversation, user?.id),
    [conversation, user?.id],
  );
  const peerOnline = usePresenceStore((state) => directPeer ? state.onlineUsers.has(directPeer.userId) : false);
  const callingSupported = useMemo(() => supportsE2EECalling(), []);
  const callDisabled = !!activeCallId && (activeCallStatus === "ringing" || activeCallStatus === "active");
  const isGroupAdmin = conversation?.type === "group" && conversation.members.find((m) => m.userId === user?.id)?.role === "admin";
  const myMembership = conversation?.members.find((m) => m.userId === user?.id);
  const isPendingRequest = myMembership?.acceptedAt === null;
  const existingMemberIds = useMemo(
    () => new Set(conversation?.members.map((m) => m.userId) ?? []),
    [conversation?.members],
  );

  useLayoutEffect(() => {
    const viewport = messageListRef.current;
    if (!viewport) return;

    const lastMessage = conversationMessages[conversationMessages.length - 1];
    const nextLastMessageId = lastMessage?.id ?? null;
    const appendedMessage = nextLastMessageId !== previousLastMessageIdRef.current;
    const latestMessageIsOwn = lastMessage?.senderId === user?.id;

    if (
      pendingInitialScrollRef.current ||
      (appendedMessage && (shouldStickToBottomRef.current || latestMessageIsOwn))
    ) {
      viewport.scrollTo?.({
        top: viewport.scrollHeight,
        behavior: pendingInitialScrollRef.current ? "auto" : "smooth",
      });
      pendingInitialScrollRef.current = false;
      shouldStickToBottomRef.current = true;
      setNewMessagesBelowCount(0);
    } else if (appendedMessage && !shouldStickToBottomRef.current) {
      setNewMessagesBelowCount((c) => c + 1);
    }

    previousLastMessageIdRef.current = nextLastMessageId;
  }, [conversationId, conversationMessages, user?.id]);

  const handleLoadOlderCachedMessages = async () => {
    if (!conversationId || loadingOlderCachedMessages) return;

    const epoch = conversationEpoch.current;
    setLoadingOlderCachedMessages(true);
    const viewport = messageListRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;

    try {
      const result = await loadOlderPersistedConversationMessages(conversationId);
      if (conversationEpoch.current !== epoch) return;
      setHasOlderCachedMessages(result.hasOlder);

      scrollFrame.current = window.requestAnimationFrame(() => {
        if (conversationEpoch.current !== epoch) return;
        const nextViewport = messageListRef.current;
        if (!nextViewport) return;
        const heightDelta = nextViewport.scrollHeight - previousHeight;
        nextViewport.scrollTop += heightDelta;
      });
    } catch (error) {
      console.error("Failed to load older cached messages", error);
    } finally {
      if (conversationEpoch.current === epoch) setLoadingOlderCachedMessages(false);
    }
  };

  const handleRenameGroup = async () => {
    if (!conversationId || !newGroupName.trim()) return;
    setRenamingGroup(true);
    try {
      await api.patch(`/api/conversations/${conversationId}`, { name: newGroupName.trim() });
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await refreshConversationList();
      setShowRenameGroup(false);
    } catch (error: any) {
      setNotice(toErrorMessage(error, "failedToRenameGroup"));
    } finally {
      setRenamingGroup(false);
    }
  };

  const handleDeleteConversation = async () => {
    if (!conversationId) return;
    setDeletingConversation(true);
    try {
      await api.delete(`/api/conversations/${conversationId}`);
      await refreshConversationList();
      useChatStore.getState().removeConversationMessages(conversationId);
      navigate("/");
    } catch (err: any) {
      setNotice(toErrorMessage(err, "failedToDeleteLeaveConversation"));
    } finally {
      setDeletingConversation(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleAcceptRequest = async () => {
    if (!conversationId) return;
    try {
      await api.post(`/api/conversations/${conversationId}/accept`);
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await refreshConversationList();
    } catch (error: any) { setNotice(toErrorMessage(error, "failedToAcceptRequest")); }
  };

  const handleDeclineRequest = async () => {
    if (!conversationId) return;
    try {
      await api.post(`/api/conversations/${conversationId}/decline`);
      await refreshConversationList();
      navigate("/");
    } catch (error: any) { setNotice(toErrorMessage(error, "failedToDeclineRequest")); }
  };

  const { handleSend, handleSendFile, outgoing, retry, discard, sendError } = useSendMessage(conversation);

  const handleStartCall = async (callType: "audio" | "video") => {
    if (!conversationId || !conversation || !user || conversation.type !== "direct") return;
    if (!callingSupported) {
      setCallUnsupported(true);
      setCallError(toErrorMessage(new E2EECallUnsupportedError()));
      return;
    }

    const token = useCallStore.getState().beginCallStart();
    if (!token) return;
    startingCallTokenRef.current = token;
    setStartingCallType(callType);
    setCallError(null);
    setCallUnsupported(false);

    const startingSession = useAuthStore.getState();
    let cancelled = false;
    let createdCallId: string | null = null;
    let promoted = false;
    let cleanupStarted = false;
    let pendingKeyWrite: Promise<void> | null = null;
    const isCurrentStart = () => {
      const currentSession = useAuthStore.getState();
      return !cancelled && useCallStore.getState().pendingCallStart?.token === token &&
        currentSession.user?.id === startingSession.user?.id && currentSession.sessionId === startingSession.sessionId &&
        currentSession.device?.id === startingSession.device?.id;
    };
    const cleanupCreatedCall = () => {
      if (!createdCallId || promoted || cleanupStarted) return;
      cleanupStarted = true;
      const id = createdCallId;
      void cleanupCallBestEffort(id, startingSession);
      // A write already in flight may commit after the first deletion.
      if (pendingKeyWrite) void pendingKeyWrite.then(() => deletePendingCall(id)).catch(() => undefined);
    };
    const cancelIfInvalid = () => {
      if (!isCurrentStart()) {
        cancelled = true;
        cleanupCreatedCall();
        stopWatching();
      }
    };
    const unsubscribeCall = useCallStore.subscribe(cancelIfInvalid);
    const unsubscribeAuth = useAuthStore.subscribe(cancelIfInvalid);
    const stopWatching = () => { unsubscribeCall(); unsubscribeAuth(); };
    try {
      if (!isCurrentStart()) return;
      const response = await api.post<InitiateCallResponse>("/api/calls/initiate", {
        conversationId,
        type: callType,
      });
      if (response.created) createdCallId = response.call.id;
      if (!isCurrentStart() || !useCallStore.getState().bindCallStart(token, response.call.id)) return;

      if (!response.created) {
        const existing = await getPendingCall(response.call.id);
        if (!isCurrentStart()) return;
        if (!existing) {
          throw new LocalizedError("aCallIsAlreadyInProgressForThis");
        }
      } else {
        const createdAt = Date.now();
        const expiresAt = createdAt + CALL_RING_TIMEOUT_MS;
        const callKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

        pendingKeyWrite = savePendingCall({
          id: response.call.id,
          conversationId,
          initiatorId: user.id,
          callType,
          callKey,
          createdAt,
          expiresAt: Math.max(expiresAt, createdAt + CALL_KEY_RECOVERY_TTL_MS),
          direction: "outgoing",
        });
        await pendingKeyWrite;
        pendingKeyWrite = null;

        if (!isCurrentStart()) return;
        const payload = JSON.stringify({
          kind: "call_offer",
          callId: response.call.id,
          conversationId,
          callType,
          callKey,
          createdAt,
          expiresAt,
          initiatorId: user.id,
        });

        await sendDirectPayloadFanout(conversation, crypto.randomUUID(), payload, "system");
      }

      if (!isCurrentStart()) return;
      stopWatching();
      promoted = setOutgoingCall({
        callId: response.call.id,
        conversationId,
        callType,
        initiatorId: user.id,
        conversationName,
      }, token);
      if (promoted) navigate(`/call/${response.call.id}`);
    } catch (err: any) {
      if (!isCurrentStart()) return;
      console.error("Failed to start call:", err);
      setCallError(toErrorMessage(err, "failedToStartCall"));
      setCallUnsupported(err instanceof E2EECallUnsupportedError);
    } finally {
      stopWatching();
      cleanupCreatedCall();
      useCallStore.getState().finishCallStart(token);
      if (startingCallTokenRef.current === token) {
        startingCallTokenRef.current = null;
        setStartingCallType(null);
      }
    }
  };

  const handleMembersAdded = () => { void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }); };

  return {
    conversationLoading,
    conversationError: (conversationError ? translateError(conversationError) : undefined),
    outgoing,
    retry,
    discard,
    sendError,
    outgoingRemoved,
    dismissOutgoingRemoval,
    pendingConfirmation,
    notice, noticeMessage,
    dismissNotice,
    conversationId,
    navigate,
    user,
    messageListRef,
    scrollToLatest: () => {
      const viewport = messageListRef.current;
      viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
      setNewMessagesBelowCount(0);
    },
    showScrollToBottom,
    newMessagesBelowCount,
    startingCallType,
    callError: callError ? renderMessage(callError) : callError,
    callUnsupported,
    showAddMembers,
    setShowAddMembers,
    showDeleteConfirm,
    setShowDeleteConfirm,
    showGroupSettings,
    setShowGroupSettings,
    showRenameGroup,
    setShowRenameGroup,
    newGroupName,
    setNewGroupName,
    renamingGroup,
    updatingInvitePolicy,
    deletingConversation,
    hasOlderCachedMessages,
    loadingOlderCachedMessages,
    handleMembersAdded,
    handleUpdateInvitePolicy,
    handleRemoveMember,
    conversation,
    conversationMessages,
    typingNames,
    handleTyping,
    conversationName,
    directPeer,
    peerOnline,
    callingSupported,
    callDisabled,
    isGroupAdmin,
    isPendingRequest,
    existingMemberIds,
    handleLoadOlderCachedMessages,
    handleRenameGroup,
    handleDeleteConversation,
    handleAcceptRequest,
    handleDeclineRequest,
    handleSend,
    handleSendFile,
    handleStartCall
  };
}
