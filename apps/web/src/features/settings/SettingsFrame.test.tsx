import { getByText, queryByText } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore.js";
import { click, setupDom } from "../../ui/test-utils.js";
import { TRANSFER_PATH, TRANSFER_SETUP_PATH } from "../transfer/HistoryTransferScreens.js";
import { SettingsFrame } from "./SettingsFrame.js";

vi.mock("../auth/UnlockOffer.js", () => ({ UnlockOffer: () => <p>Unlock faster next time</p> }));
vi.mock("../../services/api.js", () => ({ api: { get: async () => [] } }));

const { render, container } = setupDom();
const initialAuth = useAuthStore.getState();
afterEach(() => useAuthStore.setState(initialAuth, true));

it.each([TRANSFER_PATH, TRANSFER_SETUP_PATH])("defers the passkey offer on %s until the user leaves transfer", async (path) => {
  useAuthStore.setState({ user: { id: "user", username: "user", displayName: "User", avatarUrl: null, createdAt: 1, updatedAt: 1 } });
  const client = new QueryClient();
  function Settings() {
    const navigate = useNavigate();
    return <SettingsFrame title="Linked devices" section="devices" detail={<button onClick={() => navigate("/devices")}>Leave transfer</button>} />;
  }
  await render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Settings /></MemoryRouter></QueryClientProvider>);
  expect(queryByText(container(), "Unlock faster next time")).toBeNull();
  await click(getByText(container(), "Leave transfer"));
  expect(getByText(container(), "Unlock faster next time")).toBeTruthy();
});
