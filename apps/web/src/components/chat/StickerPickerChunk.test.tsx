import { act } from "react";
import { fireEvent, getByRole, waitFor } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/index.js";
import { click, setupDom } from "../../ui/test-utils.js";
import { loadStickerPicker } from "./loadStickerPicker.js";
import MessageInput from "./MessageInput.js";

vi.mock("../../services/api.js", () => ({ api: { get: async () => [] } }));
vi.mock("./loadStickerPicker.js", () => ({ loadStickerPicker: vi.fn() }));
const dom = setupDom();

it("contains a rejected picker chunk and retries without replacing the draft", async () => {
  vi.mocked(loadStickerPicker).mockRejectedValueOnce(new TypeError("chunk unavailable"))
    .mockResolvedValueOnce({ default: () => <div>Sticker pack loaded</div> });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><MessageInput onSend={vi.fn()} /></ToastProvider></QueryClientProvider>);
    const draft = getByRole<HTMLTextAreaElement>(document.body, "textbox", { name: "Message" });
    await act(async () => fireEvent.change(draft, { target: { value: "unsent draft" } }));
    await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
    await click(getByRole(document.body, "tab", { name: "Stickers" }));
    await waitFor(() => expect(getByRole(document.body, "alert").textContent).toBe("Could not load the sticker picker."));
    expect(draft).toBe(getByRole(document.body, "textbox", { name: "Message" }));
    expect(draft.value).toBe("unsent draft");

    await click(getByRole(document.body, "button", { name: "Retry" }));
    await waitFor(() => expect(dom.container().textContent).toContain("Sticker pack loaded"));
    expect(loadStickerPicker).toHaveBeenCalledTimes(2);
    expect(draft.value).toBe("unsent draft");
  } finally { log.mockRestore(); }
});
