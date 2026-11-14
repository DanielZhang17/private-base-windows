import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getDefaultUiPreferences, migrateDefaultPreferences, resolveTheme, type UiPreferences } from "../lib/ui-preferences.js";

interface UiPreferencesState {
  preferencesByUserId: Record<string, UiPreferences>;
  getPreferencesForUser: (userId: string | null | undefined, prefersDark?: boolean) => UiPreferences;
  savePreferencesForUser: (userId: string, preferences: UiPreferences) => void;
  clearPreferencesForUser: (userId: string) => void;
}

// Existing consumers select the reader itself. Derive it from the map so saves,
// resets and hydration notify those consumers immediately, including theme effects.
function preferenceState(preferencesByUserId: Record<string, UiPreferences>) {
  return {
    preferencesByUserId,
    getPreferencesForUser: (userId: string | null | undefined, prefersDark = false): UiPreferences => {
      const saved = userId ? preferencesByUserId[userId] : undefined;
      return saved ? migrateDefaultPreferences(saved, prefersDark) : getDefaultUiPreferences(resolveTheme("system", prefersDark));
    },
  };
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      ...preferenceState({}),
      savePreferencesForUser: (userId, preferences) => set((state) => preferenceState({ ...state.preferencesByUserId, [userId]: preferences })),
      clearPreferencesForUser: (userId) => set((state) => {
        const next = { ...state.preferencesByUserId };
        delete next[userId];
        return preferenceState(next);
      }),
    }),
    {
      name: "e2ee-ui-preferences",
      partialize: (state) => ({ preferencesByUserId: state.preferencesByUserId }),
      merge: (persisted, current) => ({
        ...current,
        ...preferenceState((persisted as Partial<UiPreferencesState> | undefined)?.preferencesByUserId ?? current.preferencesByUserId),
      }),
    },
  ),
);
