import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposer, type ComposerOptions } from "./useComposer.js";
import { compressAttachment } from "./attachment-compression.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
import { getDefaultUiPreferences } from "../../lib/ui-preferences.js";
import { ActionMenu } from "../../ui/ActionMenu.js";
import MessageInput from "../../components/chat/MessageInput.js";
import { fireEvent } from "@testing-library/dom";
vi.mock("../../services/api.js", () => ({ api: { get: async () => [] } }));
vi.mock("../../stores/authStore.js", () => {
  const auth = { user: { id: "alice" }, sessionId: "session" };
  return { useAuthStore: Object.assign((selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth }) };
});
vi.mock("./attachment-compression.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./attachment-compression.js")>(),
  compressAttachment: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let dropArea: HTMLDivElement | null;
let result: ReturnType<typeof useComposer>;
const send = vi.fn(); const sendFile = vi.fn();
function Probe({ disabled = false, ...edit }: Partial<Pick<ComposerOptions, "disabled" | "editing" | "editConflict" | "onSaveEdit" | "onCancelEdit">>) {
  const dropTarget = useRef<HTMLDivElement>(null);
  result = useComposer({ onSend: send, onSendFile: sendFile, disabled, dropTarget, ...edit });
  return <div ref={(node) => { dropTarget.current = dropArea = node; }}><textarea ref={result.inputRef} /></div>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(compressAttachment).mockReset();
  useUiPreferencesStore.getState().clearPreferencesForUser("alice");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (disabled = false) => { await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe disabled={disabled} /></QueryClientProvider>)); };
function drop(file: File) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  dropArea!.querySelector("textarea")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}
it("retains a picked file until Send and passes the selected timer to the queue callback", async () => {
  await render(); const file = new File(["private"], "route.pdf", { type: "application/pdf" });
  await act(async () => result.handleFileChange({ target: { files: [file], value: "" } } as never));
  expect(sendFile).not.toHaveBeenCalled(); expect(result.pendingFile).toBe(file);
  await act(async () => result.setTtlSeconds("300"));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(sendFile).toHaveBeenCalledExactlyOnceWith(file, { ttlSeconds: 300 });
  expect(result.pendingFile).toBeNull();
});
it("does not send dropped files from a disabled composer", async () => {
  await render(true);
  await act(async () => drop(new File(["x"], "private.txt")));
  expect(result.pendingFile).toBeNull(); expect(sendFile).not.toHaveBeenCalled();
});
it("cancels native file drops while editing without staging an attachment", async () => {
  const client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={{ id: "message", content: "edit draft" }} />
  </QueryClientProvider>));
  const over = new Event("dragover", { bubbles: true, cancelable: true });
  const dataTransfer = { types: ["Files"], dropEffect: "copy" };
  Object.defineProperty(over, "dataTransfer", { value: dataTransfer });
  await act(async () => { dropArea!.querySelector("textarea")!.dispatchEvent(over); });
  expect(over.defaultPrevented).toBe(true);
  expect(dataTransfer.dropEffect).toBe("none");
  expect(result.dragging).toBe(false);
  await act(async () => drop(new File(["x"], "private.txt")));
  expect(result.pendingFile).toBeNull();
  expect(sendFile).not.toHaveBeenCalled();
  expect(result.text).toBe("edit draft");
});
it("stages dropped media with the account default and sends only on submit", async () => {
  useUiPreferencesStore.getState().savePreferencesForUser("alice", { ...getDefaultUiPreferences("light"), compressAttachments: true });
  await render();
  const video = new File(["original video"], "holiday.mov", { type: "video/quicktime" });
  const encoded = new File(["video"], "holiday.mp4", { type: "video/mp4" });
  vi.mocked(compressAttachment).mockResolvedValue(encoded);
  await act(async () => drop(video));
  expect(result.pendingFile).toBe(video);
  expect(result.compress).toBe(true);
  expect(compressAttachment).not.toHaveBeenCalled();
  expect(sendFile).not.toHaveBeenCalled();
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(compressAttachment).toHaveBeenCalledExactlyOnceWith(video, expect.any(AbortSignal));
  expect(sendFile).toHaveBeenCalledExactlyOnceWith(encoded, { ttlSeconds: null });
  await act(async () => drop(video));
  await act(async () => result.setCompress(false));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(sendFile).toHaveBeenLastCalledWith(video, { ttlSeconds: null });
});

it("keeps the attachment and message ready for an explicit retry when compression fails", async () => {
  await render();
  const image = new File(["image"], "photo.gif", { type: "image/gif" });
  vi.mocked(compressAttachment).mockRejectedValue(new Error("Unsupported"));
  await act(async () => { drop(image); result.setText("A caption"); result.setCompress(true); });
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(result.pendingFile).toBe(image);
  expect(result.text).toBe("A caption");
  expect(result.attachmentError).toBe("attachmentCompressionFailed");
  expect(sendFile).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("aborts an in-flight attachment when the composer unmounts", async () => {
  await render();
  const image = new File(["image"], "photo.jpg", { type: "image/jpeg" });
  let finish!: (file: File) => void;
  vi.mocked(compressAttachment).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => { drop(image); result.setCompress(true); });
  let submitting!: Promise<void>;
  await act(async () => { submitting = result.handleSubmit({ preventDefault() {} } as never); });
  const signal = vi.mocked(compressAttachment).mock.calls[0][1];
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  finish(image);
  await submitting;
  expect(sendFile).not.toHaveBeenCalled();
  root = createRoot(document.createElement("div"));
});
it("keeps Enter as a newline on a touch keyboard and while composing text", async () => {
  await render(); await act(async () => result.setText("Hello"));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const preventDefault = vi.fn();
  await act(async () => result.handleKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault } as never));
  expect(send).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  await act(async () => result.handleKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true }, preventDefault } as never));
  expect(send).not.toHaveBeenCalled();
});

it("edits inline, preserves the unsent draft, and saves only non-empty text on desktop Enter", async () => {
  const onSaveEdit = vi.fn(async () => true), onCancelEdit = vi.fn();
  const editing = { id: "message", content: "previous text" };
  const client = new QueryClient();
  const render = (target?: typeof editing) => act(async () => root.render(
    <QueryClientProvider client={client}><Probe editing={target} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} /></QueryClientProvider>,
  ));
  await render();
  await act(async () => result.setText("new-message draft"));
  await render(editing);
  expect(result.text).toBe("previous text");
  const key = (key: string) => act(async () => result.handleKeyDown({
    key, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {},
  } as never));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  await act(async () => result.setText("   "));
  await key("Enter");
  expect(onSaveEdit).not.toHaveBeenCalled();
  await key("Escape");
  expect(onCancelEdit).toHaveBeenCalledOnce();
  await render();
  expect(result.text).toBe("new-message draft");
  await render(editing);
  await act(async () => result.setText("  updated text  "));
  await key("Enter");
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "updated text");
  expect(onCancelEdit).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
});

it("shows shortcodes and saves the original emoji IDs even when a shortcode has been reassigned", async () => {
  const onSaveEdit = vi.fn(async () => true), onCancelEdit = vi.fn();
  const editing = { id: "message", content: "First [[emoji:old1:wave]], then [[emoji:old2:wave]] and [[emoji:gone:retired]]" };
  const client = new QueryClient();
  client.setQueryData(["myCustomEmojis"], [{ id: "replacement", shortcode: "wave" }, { id: "new1", shortcode: "plus" }]);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={editing} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />
  </QueryClientProvider>));
  expect(result.text).toBe("First :wave:, then :wave: and :retired:");
  const submit = () => act(async () => result.handleSubmit({ preventDefault() {} } as never));
  await submit();
  expect(onCancelEdit).toHaveBeenCalledOnce();
  expect(onSaveEdit).not.toHaveBeenCalled();
  // Inserting the same shortcode at the first token's position must not steal
  // the ID from the original token that moved to the right.
  const prefix = "First ";
  const inserted = ":wave: ";
  await act(async () => result.setText(prefix + inserted + result.text.slice(prefix.length), prefix.length + inserted.length));
  await act(async () => result.setText(`${result.text}! :plus:`));
  await submit();
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", `First [[emoji:replacement:wave]] ${editing.content.slice(prefix.length)}! [[emoji:new1:plus]]`);
});

it("serializes a retained emoji before a neighboring shortcode can consume its opening colon", async () => {
  const onSaveEdit = vi.fn(async () => true);
  const client = new QueryClient();
  client.setQueryData(["myCustomEmojis"], [{ id: "newnote", shortcode: "note" }]);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={{ id: "message", content: "[[emoji:oldwave:wave]] after" }} onSaveEdit={onSaveEdit} />
  </QueryClientProvider>));
  await act(async () => result.setText(`:note${result.text}`, 5));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", ":note[[emoji:oldwave:wave]] after");
});

it("saves a replacement emoji ID even when the visible shortcode is unchanged", async () => {
  const onSaveEdit = vi.fn(async () => true);
  const client = new QueryClient();
  client.setQueryData(["myCustomEmojis"], [{ id: "newwave", shortcode: "wave" }]);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={{ id: "message", content: "Hello [[emoji:oldwave:wave]]" }} onSaveEdit={onSaveEdit} />
  </QueryClientProvider>));
  expect(result.text).toBe("Hello :wave:");
  await act(async () => result.setText("Hello ", 6));
  await act(async () => result.setText("Hello :wave:", 12));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "Hello [[emoji:newwave:wave]]");
});

it("replaces only the explicitly picked emoji when the visible shortcode is identical", async () => {
  const onSaveEdit = vi.fn(async () => true);
  const client = new QueryClient();
  client.setQueryData(["myCustomEmojis"], [{ id: "newwave", shortcode: "wave" }]);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={{ id: "message", content: "[[emoji:old1:wave]] [[emoji:old2:wave]]" }} onSaveEdit={onSaveEdit} />
  </QueryClientProvider>));
  const textarea = result.inputRef.current!;
  textarea.value = result.text;
  textarea.setSelectionRange(7, 13);
  await act(async () => result.insertAtCursor(":wave:"));
  expect(result.text).toBe(":wave: :wave:");
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "[[emoji:old1:wave]] [[emoji:newwave:wave]]");
});

it("preserves literal shortcodes and only resolves shortcodes in newly edited spans", async () => {
  const onSaveEdit = vi.fn(async () => true), onCancelEdit = vi.fn();
  const client = new QueryClient();
  client.setQueryData(["myCustomEmojis"], [{ id: "newwave", shortcode: "wave" }]);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={{ id: "message", content: "Literal :wave:" }} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />
  </QueryClientProvider>));
  const submit = () => act(async () => result.handleSubmit({ preventDefault() {} } as never));
  await submit();
  expect(onSaveEdit).not.toHaveBeenCalled();
  expect(onCancelEdit).toHaveBeenCalledOnce();
  await act(async () => result.setText("Literal :wave: and new :wave:"));
  await submit();
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "Literal :wave: and new [[emoji:newwave:wave]]");
});

it("keeps a conflicted draft open on submit", async () => {
  const onSaveEdit = vi.fn(async () => false), onCancelEdit = vi.fn();
  const client = new QueryClient();
  const editing = { id: "message", content: "original" };
  const render = (editConflict: boolean) => act(async () => root.render(<QueryClientProvider client={client}>
    <Probe editing={editing} editConflict={editConflict} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />
  </QueryClientProvider>));
  await render(false);
  await act(async () => result.setText("draft to keep"));
  await render(true);
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(result.text).toBe("draft to keep");
  expect(onSaveEdit).not.toHaveBeenCalled();
  expect(onCancelEdit).not.toHaveBeenCalled();
});

it("blocks even an already-captured emoji insertion handler while saving", async () => {
  let finish!: (saved: boolean) => void;
  const onSaveEdit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>
    <Probe editing={{ id: "message", content: "original" }} onSaveEdit={onSaveEdit} />
  </QueryClientProvider>));
  await act(async () => result.setText("revised"));
  const insert = result.insertAtCursor;
  let save!: Promise<void>;
  await act(async () => {
    save = result.handleSubmit({ preventDefault() {} } as never);
    insert("🙂");
  });
  expect(result.text).toBe("revised");
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "revised");
  await act(async () => { finish(false); await save; });
});

it("disables the emoji button and removes an open picker while saving an edit", async () => {
  let finish!: (saved: boolean) => void;
  const onSaveEdit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>
    <MessageInput editing={{ id: "message", content: "original" }} onSend={send} onSaveEdit={onSaveEdit} />
  </QueryClientProvider>));
  const emoji = host.querySelector<HTMLButtonElement>('button[aria-label="Add emoji"]')!;
  const textarea = host.querySelector("textarea")!;
  await act(async () => { fireEvent.change(textarea, { target: { value: "revised" } }); emoji.click(); });
  expect(host.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull();
  await act(async () => { fireEvent.submit(host.querySelector("form")!); });
  expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith("message", "revised");
  expect(emoji.disabled).toBe(true);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
  await act(async () => { finish(false); });
  expect(emoji.disabled).toBe(false);
});

it("hands focus from a mobile message action sheet to the edit composer", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  function MobileChat() {
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Message actions</button>
      <ActionMenu title="Message actions" open={open} onClose={() => setOpen(false)} position={{ x: 10, y: 10 }}
        items={[{ id: "edit", label: "Edit message", onSelect: () => setEditing(true) }]} />
      <Probe editing={editing ? { id: "message", content: "original" } : undefined} />
    </>;
  }
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><MobileChat /></QueryClientProvider>));
  const trigger = host.querySelector("button")!;
  await act(async () => { trigger.focus(); trigger.click(); });
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  expect(result.text).toBe("original");
});
