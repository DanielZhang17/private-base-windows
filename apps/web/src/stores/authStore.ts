import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User, Device, AuthResponse, LoginRequest, UpdateProfileResponse } from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { lockLocalCryptoState } from "../lib/key-manager.js";
import { clearRegisteredAccountState } from "../platform/session-cleanup.js";

interface AuthState {
  user: User | null;
  device: Device | null;
  accessToken: string | null;
  refreshToken: string | null;
  authEpoch: number;
  /**
   * Identifies one login. Unlike authEpoch it changes only when a session is created or ended
   * (not on idle lock, identity repair or token rotation), and it is persisted so other tabs
   * of the same login see the same value.
   */
  sessionId: string | null;
  applyAuthResponse: (response: AuthResponse) => void;
  repairSessionIdentity: (session: { user: User; device: Device }) => void;
  register: (
    username: string,
    displayName: string,
    password: string,
    recoveryKey: string,
    deviceName: string,
    identityKey: string,
    avatarUrl?: string | null,
  ) => Promise<void>;
  login: (payload: LoginRequest) => Promise<void>;
  setTokens: (accessToken: string, refreshToken: string) => void;
  updateProfile: (data: { displayName?: string; avatarUrl?: string | null }) => Promise<void>;
  logout: (options?: { forgetDevice?: boolean }) => void;
  bumpSessionState: () => void;
}

function newSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      device: null,
      accessToken: null,
      refreshToken: null,
      authEpoch: 0,
      sessionId: null,
      applyAuthResponse: (response) => set((state) => ({
        user: response.user,
        device: response.device,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        authEpoch: state.authEpoch + 1,
        sessionId: newSessionId(),
      })),
      repairSessionIdentity: (session) => set((state) => ({
        user: session.user,
        device: session.device,
        authEpoch: state.authEpoch + 1,
      })),
      register: async (username, displayName, password, recoveryKey, deviceName, identityKey, avatarUrl) => {
        const res = await api.post<AuthResponse>("/auth/register", {
          username,
          displayName,
          password,
          recoveryKey,
          avatarUrl: avatarUrl ?? null,
          device: { name: deviceName, identityKey },
        });
        set((state) => ({
          user: res.user,
          device: res.device,
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          authEpoch: state.authEpoch + 1,
          sessionId: newSessionId(),
        }));
      },
      login: async (payload) => {
        const res = await api.post<AuthResponse>("/auth/login", payload);
        set((state) => ({
          user: res.user,
          device: res.device,
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          authEpoch: state.authEpoch + 1,
          sessionId: newSessionId(),
        }));
      },
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      updateProfile: async (data) => {
        const res = await api.put<UpdateProfileResponse>("/api/users/profile", data);
        set({ user: res.user });
      },
      logout: (options) => {
        lockLocalCryptoState();
        set((state) => ({
          user: null,
          device: options?.forgetDevice ? null : state.device,
          accessToken: null,
          refreshToken: null,
          authEpoch: state.authEpoch + 1,
          sessionId: null,
        }));
      },
      bumpSessionState: () => set((state) => ({ authEpoch: state.authEpoch + 1 })),
    }),
    { name: "e2ee-auth" }
  )
);

if (typeof window !== "undefined") {
  // Initial hydration has no live session to clean up. Guard later hydrations before publication.
  useAuthStore.persist?.setOptions({
    merge: (persisted, current) => {
      const next = { ...current, ...(persisted as Partial<AuthState>) };
      if (!next.accessToken || next.sessionId !== current.sessionId || next.user?.id !== current.user?.id) {
        clearRegisteredAccountState();
        lockLocalCryptoState();
        // Different logins can share an epoch; still make the auth phase reevaluate the lock.
        if (next.accessToken && next.authEpoch === current.authEpoch) next.authEpoch += 1;
      }
      return next;
    },
  });
  window.addEventListener("storage", async (event) => {
    if (event.key === "e2ee-auth") {
      await useAuthStore.persist.rehydrate();
    }
  });
}
