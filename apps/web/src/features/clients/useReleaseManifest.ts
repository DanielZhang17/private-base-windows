import { useCallback, useEffect, useRef, useState } from "react";

type ManifestState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  /** retrying: "Try again" was pressed; the error stays on screen with a busy button. */
  | { status: "error"; retrying: boolean };

/** Loads public release metadata on mount. Fetch and validation failures all become "error". */
export function useReleaseManifest<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<ManifestState<T>>({ status: "loading" });
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    load(current.signal).then(
      (data) => { if (controller.current === current) setState({ status: "ready", data }); },
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
