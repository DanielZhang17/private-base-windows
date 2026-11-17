import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface CallPlayback {
  hasBlockedMedia: boolean;
  hasBlockedVideo: boolean;
  updateBlocked: (element: HTMLMediaElement, resume: (() => void) | null) => void;
  resumeBlocked: () => void;
}
const CallPlaybackContext = createContext<CallPlayback | null>(null);

/** One registry for the persistent audio owner and all mounted remote videos. */
export function CallPlaybackProvider({ children }: { children: ReactNode }) {
  const [blocked, setBlocked] = useState(() => new Map<HTMLMediaElement, () => void>());
  const updateBlocked = useCallback((element: HTMLMediaElement, resume: (() => void) | null) => {
    setBlocked((current) => {
      if (resume ? current.get(element) === resume : !current.has(element)) return current;
      const next = new Map(current);
      if (resume) next.set(element, resume); else next.delete(element);
      return next;
    });
  }, []);
  const resumeBlocked = () => {
    // Do not await: every play() must run within this same user gesture.
    for (const resume of blocked.values()) resume();
  };
  return <CallPlaybackContext.Provider value={{
    hasBlockedMedia: blocked.size > 0,
    hasBlockedVideo: Array.from(blocked.keys()).some((element) => element.tagName === "VIDEO"),
    updateBlocked, resumeBlocked,
  }}>{children}</CallPlaybackContext.Provider>;
}

export function useCallPlayback() { return useContext(CallPlaybackContext); }
