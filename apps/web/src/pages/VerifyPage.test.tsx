import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import VerifyPage from "./VerifyPage.js";
import { useSafetyNumber } from "../features/verify/useSafetyNumber.js";
import { ToastProvider } from "../ui/index.js";
import { click, setupDom } from "../ui/test-utils.js";
vi.mock("../features/verify/useSafetyNumber.js", () => ({ useSafetyNumber: vi.fn() }));
vi.mock("../features/settings/SettingsFrame.js", () => ({
  SettingsFrame: ({ detail }: { detail: React.ReactNode }) => <ToastProvider>
    {detail}
  </ToastProvider>
}));
const { render } = setupDom();
const copy = vi.fn(async () => { });
const verify = vi.fn(() => true);
let state: ReturnType<typeof useSafetyNumber>;
beforeEach(() => {
  vi.clearAllMocks();
  state = { localUser: { displayName: "Sam" }, remoteUser: { displayName: "Mara" }, groups: Array.from({ length: 12 }, (_, i) => String(i).padStart(5, "0")), safetyNumber: "12345", copySafetyNumber: copy, toggleVerification: verify } as unknown as ReturnType<typeof useSafetyNumber>;
});
async function show() {
  vi.mocked(useSafetyNumber).mockReturnValue(state); await render(<MemoryRouter>
    <VerifyPage />
  </MemoryRouter>);
}
it("renders twelve safety number groups and exposes copy and verification actions", async () => {
  await show(); const number = document.querySelector('[aria-label="Safety number"]')!;
  expect(number.children.length).toBe(12); expect(number.className).toContain("grid-cols-3"); expect(number.className).toContain("sm:grid-cols-4");
  const buttons = Array.from(document.querySelectorAll("button"));
  await click(buttons.find((button) => button.textContent === "Copy")!); expect(copy).toHaveBeenCalledTimes(1);
  await click(buttons.find((button) => button.textContent === "Mark as verified")!); expect(verify).toHaveBeenCalledTimes(1);
});
it("explains unfinished setup instead of showing a computing grid forever", async () => {
  state = { ...state, noIdentity: true, safetyNumber: null }; await show();
  expect(document.body.textContent).toContain("Mara has not finished setting up."); expect(document.querySelector('[aria-label="Safety number"]')).toBeNull();
});
