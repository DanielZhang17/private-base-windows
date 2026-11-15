import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAddMembers } from "./useAddMembers.js";
import { api } from "../../services/api.js";
import { setLocalePreference, t } from "../../i18n/index.js";
import { setupDom } from "../../ui/test-utils.js";
vi.mock("../../services/api.js", () => ({ api: { post: vi.fn() } }));
const { render } = setupDom();
let state: ReturnType<typeof useAddMembers>;
const added = vi.fn(), close = vi.fn();
function Probe() { state = useAddMembers("group", added, close); return null; }
beforeEach(() => { vi.clearAllMocks(); });
it("shows a neutral translated error for unavailable invitees and preserves selection", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("One or more users are unavailable"));
  await render(<Probe />);
  await act(async () => state.setSelectedUsers([{ id: "bob", username: "bob", displayName: "Bob", avatarUrl: null }]));
  await act(async () => { await state.handleAdd(); });
  expect(api.post).toHaveBeenCalledWith("/api/conversations/group/members", { userIds: ["bob"] });
  expect(state.error).toBe("This person can't be added");
  expect(added).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(state.selectedUsers[0].id).toBe("bob");
  await act(async () => { await setLocalePreference("fr"); });
  expect(state.error).toBe(t("personCannotBeAdded"));
});
