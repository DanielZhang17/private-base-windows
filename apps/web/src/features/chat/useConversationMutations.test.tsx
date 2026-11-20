import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversationMutations } from "./useConversationMutations.js";
import { api } from "../../services/api.js";
vi.mock("../../services/api.js", () => ({ api: { delete: vi.fn() } }));
vi.mock("../../lib/conversation-cache.js", () => ({ refreshConversationList: vi.fn(async () => {}) }));
let result: ReturnType<typeof useConversationMutations>; let root: Root;
const deleted = vi.fn();
function Probe() { result = useConversationMutations("group", deleted); return null; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); root = createRoot(document.createElement("div"));
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("keeps a failed member removal open and retries the same member", async () => {
  await act(async () => result.requestRemoval({ userId: "tomas", displayName: "Tomas" }));
  vi.mocked(api.delete).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => result.removeMember());
  expect(result.removeTarget?.displayName).toBe("Tomas"); expect(result.removeError).toBe("Could not remove member\nOffline");
  vi.mocked(api.delete).mockResolvedValueOnce({} as never);
  await act(async () => result.removeMember());
  expect(api.delete).toHaveBeenLastCalledWith("/api/conversations/group/members/tomas");
  expect(result.removeTarget).toBeNull();
});
it("keeps deletion failures in the confirmation and only leaves after success", async () => {
  vi.mocked(api.delete).mockRejectedValueOnce(new Error("Could not leave"));
  await act(async () => result.deleteConversation("leave"));
  expect(result.deleteError).toBe("Could not leave conversation\nCould not leave"); expect(deleted).not.toHaveBeenCalled();
  vi.mocked(api.delete).mockResolvedValueOnce({} as never);
  await act(async () => result.deleteConversation("leave"));
  expect(deleted).toHaveBeenCalledOnce();
});

it("uses distinct endpoints for group self-removal and intentional whole-group deletion", async () => {
  vi.mocked(api.delete).mockResolvedValue({} as never);
  await act(async () => result.deleteConversation("leave"));
  expect(api.delete).toHaveBeenLastCalledWith("/api/conversations/group/membership");
  await act(async () => result.deleteConversation("deleteGroup"));
  expect(api.delete).toHaveBeenLastCalledWith("/api/conversations/group?action=delete");
});
