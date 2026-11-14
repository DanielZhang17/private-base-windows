import { useMemo, useState, useEffect, useRef } from "react";
import { useContacts, type Contact } from "./useContacts.js";
import { api } from "../services/api.js";

interface SearchUserResult {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export function useUserSearch(
  query: string,
  excludeIds: Set<string>,
): { results: Contact[]; loading: boolean } {
  const contacts = useContacts();
  const [apiResults, setApiResults] = useState<SearchUserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim().toLowerCase();

  useEffect(() => {
    abortRef.current?.abort();
    setApiResults([]);

    if (trimmed.length < 2) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = window.setTimeout(async () => {
      try {
        const results = await api.get<SearchUserResult[]>(
          `/api/users/search?q=${encodeURIComponent(trimmed)}`,
        );
        if (!controller.signal.aborted) {
          setApiResults(results);
        }
      } catch {
        if (!controller.signal.aborted) {
          setApiResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const results = useMemo(() => {
    const merged = new Map<string, Contact>();

    for (const contact of contacts) {
      if (excludeIds.has(contact.id)) continue;
      if (
        trimmed &&
        !contact.displayName.toLowerCase().includes(trimmed) &&
        !contact.username.toLowerCase().includes(trimmed)
      ) {
        continue;
      }
      merged.set(contact.id, contact);
    }

    for (const user of apiResults) {
      if (excludeIds.has(user.id)) continue;
      if (merged.has(user.id)) continue;
      merged.set(user.id, {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      });
    }

    return [...merged.values()];
  }, [contacts, apiResults, excludeIds, trimmed]);

  return { results, loading: loading && trimmed.length >= 2 };
}
