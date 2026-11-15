import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { translateError, toErrorMessage } from "../shared/errors.js";
import { formatDate, formatRelativeTimestamp } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import type { ConversationWithMembers } from "@e2ee-chat/shared";

import { type PickerUser } from "../../components/user-picker/UserPicker.js";
import {
  CONVERSATIONS_QUERY_KEY,
  fetchConversationList,
  refreshConversationList,
} from "../../lib/conversation-cache.js";
import { usePresenceStore } from "../../stores/presenceStore.js";

function relativeTime(timestamp: number): string {
  return Date.now() - timestamp < 604_800_000 ? formatRelativeTimestamp(timestamp) : formatDate(timestamp, { month: "short", day: "numeric" });
}

function getLastMessagePreview(content: string, type: string): string {
  if (type === "file") return t("sentAFile");
  if (type === "system" || type === "key_exchange" || type === "sender_key_distribution") return "";
  return content.length > 50 ? content.slice(0, 50) + "..." : content;
}

interface SearchUserResult {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export function useChatList() {
  useLocale();
  const navigate = useNavigate();
  const creating = useRef(false);
  const queryClient = useQueryClient();
  const errorDataVersion = useRef(0);
  const [listError, setListError] = useState<LocalizedMessage | null>(null);
  const user = useAuthStore((s) => s.user);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const allMessages = useChatStore((s) => s.messages);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newChatUsername, setNewChatUsername] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<PickerUser[]>([]);
  const [newChatError, setNewChatError] = useState<LocalizedMessage | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);

  const { data: conversations, isLoading, error: queryError, dataUpdatedAt, isFetching } = useQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: fetchConversationList,
  });

  useEffect(() => {
    const version = queryClient.getQueryState(CONVERSATIONS_QUERY_KEY)?.dataUpdateCount ?? 0;
    if (!isFetching && version > errorDataVersion.current) setListError(null);
  }, [dataUpdatedAt, isFetching, queryClient]);

  const openChat = (id: string) => {
    setActiveConversation(id);
    navigate(`/chat/${id}`);
  };

  const getDirectPeer = (conv: ConversationWithMembers) => {
    if (conv.type !== "direct") return null;
    if (!user?.id) return null;
    return conv.members.find((member) => member.userId !== user.id) ?? null;
  };

  const getConversationName = (conv: ConversationWithMembers) => {
    if (conv.name) return conv.name;
    if (conv.type === "direct") {
      return getDirectPeer(conv)?.user.displayName || t("directMessage");
    }
    const otherMembers = user?.id
      ? conv.members.filter((member) => member.userId !== user.id)
      : conv.members;
    const memberNames = otherMembers.map((member) => member.user.displayName).join(", ");
    return memberNames ? t("groupNameFallback", { memberNames: memberNames }) : t("groupChat");
  };

  const startNewChat = async () => {
    const username = newChatUsername.trim();
    if (!username) return;

    if (creating.current) return;
    creating.current = true;
    setNewChatError(null);
    setCreatingChat(true);
    try {
      const matches = await api.get<SearchUserResult[]>(
        `/api/users/search?q=${encodeURIComponent(username)}&exact=1`
      );
      const target = matches.find((u) => u.username === username);

      if (!target) {
        setNewChatError(localized("userNotFound"));
        return;
      }
      if (target.id === user?.id) {
        setNewChatError(localized("youCannotStartAChatWithYourself"));
        return;
      }

      const created = await api.post<{ id: string; existing?: boolean }>("/api/conversations", {
        type: "direct",
        memberUserIds: [target.id],
      });

      await refreshConversationList();
      setShowNewChat(false);
      setNewChatUsername("");
      openChat(created.id);
    } catch (err: any) {
      setNewChatError(toErrorMessage(err, "failedToCreateChat"));
    } finally {
      creating.current = false;
      setCreatingChat(false);
    }
  };

  const startNewGroup = async () => {
    if (groupMembers.length === 0) {
      setNewChatError(localized("addAtLeastOneMember"));
      return;
    }

    if (creating.current) return;
    creating.current = true;
    setNewChatError(null);
    setCreatingChat(true);
    try {
      const memberIds = groupMembers.map((m) => m.id);

      const created = await api.post<{ id: string }>("/api/conversations", {
        type: "group",
        memberUserIds: memberIds,
        name: groupName.trim() || undefined,
      });

      await refreshConversationList();
      setShowNewGroup(false);
      setGroupName("");
      setGroupMembers([]);
      openChat(created.id);
    } catch (err: any) {
      setNewChatError(toErrorMessage(err, "failedToCreateGroup"));
    } finally {
      creating.current = false;
      setCreatingChat(false);
    }
  };

  const respondToRequest = async (id: string, action: "accept" | "decline") => {
    try {
      setListError(null);
      await api.post(`/api/conversations/${id}/${action}`);
      await refreshConversationList();
    } catch (error: any) {
      errorDataVersion.current = queryClient.getQueryState(CONVERSATIONS_QUERY_KEY)?.dataUpdateCount ?? 0;
      setListError(toErrorMessage(error, "failedToRespondToRequest"));
    }
  };
  const pendingConversations = conversations?.filter((conv) => conv.members.find((m) => m.userId === user?.id)?.acceptedAt === null) ?? [];
  const acceptedConversations = conversations?.filter((conv) => conv.members.find((m) => m.userId === user?.id)?.acceptedAt !== null) ?? [];

  return {
    respondToRequest,
    pendingConversations,
    acceptedConversations,
    isLoading,
    listError: listError ? renderMessage(listError) : listError,
    loadError: (queryError ? translateError(queryError) : undefined),
    dismissListError: () => setListError(null),
    user,
    onlineUsers,
    unreadCounts,
    allMessages,
    showNewChat,
    setShowNewChat,
    showNewGroup,
    setShowNewGroup,
    newChatUsername,
    setNewChatUsername,
    groupName,
    setGroupName,
    groupMembers,
    setGroupMembers,
    newChatError: newChatError ? renderMessage(newChatError) : newChatError,
    setNewChatError,
    creatingChat,
    conversations,
    openChat,
    getDirectPeer,
    getConversationName,
    startNewChat,
    startNewGroup,
    relativeTime,
    getLastMessagePreview
  };
}
