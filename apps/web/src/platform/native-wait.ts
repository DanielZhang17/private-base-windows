export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export async function withNativeDeadline<T>(
  duration: number, run: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal,
): Promise<T> {
  assertNotAborted(caller);
  const controller = new AbortController();
  let rejectWait!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectWait = reject; });
  const stop = (reason: unknown) => {
    controller.abort(reason);
    rejectWait(reason);
  };
  const cancel = () => { if (caller) stop(abortReason(caller)); };
  const timer = setTimeout(() => stop(new DOMException("Native operation timed out", "TimeoutError")), duration);
  caller?.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([aborted, run(controller.signal)]); }
  finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", cancel);
  }
}
