import { act } from "react";
import { expect, it, vi } from "vitest";
import { Disclosure } from "./index.js";
import { setupDom } from "./test-utils.js";

const { render, container } = setupDom();

it("is closed by default with a 44px summary and a decorative chevron", async () => {
  await render(<Disclosure summary="Verify download"><p>Checksum</p></Disclosure>);
  const details = container().querySelector("details")!;
  const summary = details.querySelector("summary")!;
  expect(details.open).toBe(false);
  expect(summary.textContent).toBe("Verify download");
  expect(summary.className).toContain("min-h-11");
  const chevron = summary.querySelector("svg[data-icon='chevron-down']")!;
  expect(chevron.getAttribute("aria-hidden")).toBe("true");
  expect(chevron.getAttribute("class")).toContain("group-open/disclosure:rotate-180");
  expect(details.querySelector("p")?.textContent).toBe("Checksum");
});

it("opens from defaultOpen and reports toggles", async () => {
  const onToggle = vi.fn();
  await render(<Disclosure summary="More" defaultOpen onToggle={onToggle} className="mt-4"><p>Body</p></Disclosure>);
  const details = container().querySelector("details")!;
  expect(details.open).toBe(true);
  expect(details.className).toContain("mt-4");
  await act(async () => {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(details.open).toBe(false);
  expect(onToggle).toHaveBeenLastCalledWith(false);
});
