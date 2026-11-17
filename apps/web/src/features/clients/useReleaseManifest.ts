import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReleaseManifest, type ReleaseManifest } from "./manifest.js";

export type ManifestState =
  | { status: "loading" }
  | { status: "ready"; manifest: ReleaseManifest }
  /** retrying: "Try again" was pressed; the error stays on screen with a busy button. */
  | { status: "error"; retrying: boolean };

/** Loads latest.json on mount. Network, timeout, HTTP and validation failures all become "error". */
export function useReleaseManifest(load: typeof fetchReleaseManifest = fetchReleaseManifest) {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    load(current.signal).then(
      (manifest) => { if (controller.current === current) setState({ status: "ready", manifest }); },
      () => { if (controller.current === current) setState({ status: "error", retrying: false }); },
    );
  }, [load]);

  useEffect(() => {
    run();
    return () => {
      const current = controller.current;
      controller.current = null;
      current?.abort();
    };
  }, [run]);

  const retry = useCallback(() => {
    setState((previous) => (previous.status === "error" ? { status: "error", retrying: true } : previous));
    run();
  }, [run]);

  return { state, retry };
}
