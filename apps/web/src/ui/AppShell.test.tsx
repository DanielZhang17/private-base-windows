import { expect, it, vi } from "vitest";
import { AppShell, BottomBar, NavItem, NavRail, TopBar } from "./index.js";
import { click, setupDom } from "./test-utils.js";

const { render, container } = setupDom();
const $ = (selector: string) => container().querySelector<HTMLElement>(selector)!;
const classes = (element: Element) => element.className.split(/\s+/);

it("AppShell shows the list pane on phones when no detail is open", async () => {
  await render(<AppShell list={<p>list</p>} placeholder={<p>nothing open</p>} />);
  expect(classes($("aside"))).toContain("flex");
  expect(classes($("aside"))).not.toContain("hidden");
  // The detail pane is hidden below sm and shown from sm up.
  expect(classes($("main"))).toEqual(expect.arrayContaining(["hidden", "sm:flex"]));
  expect($("main").textContent).toBe("nothing open");
});

it("AppShell swaps to the detail pane on phones and keeps both from sm up", async () => {
  await render(<AppShell list={<p>list</p>} detail={<p>conversation</p>} />);
  expect(classes($("aside"))).toEqual(expect.arrayContaining(["hidden", "sm:flex"]));
  expect(classes($("main"))).toContain("flex");
  expect(classes($("main"))).not.toContain("hidden");
  expect($("main").textContent).toBe("conversation");
});

it("AppShell lets detailActive override which pane a phone shows", async () => {
  await render(<AppShell list={<p>list</p>} detail={<p>settings</p>} detailActive={false} />);
  expect(classes($("aside"))).not.toContain("hidden");
  expect(classes($("main"))).toContain("hidden");
});

it("AppShell has landmarks, a title-bar drag strip, and hides the bottom bar on desktop when a rail exists", async () => {
  await render(
    <AppShell
      list={<p>list</p>}
      banner={<p>offline</p>}
      rail={<NavRail><NavItem icon="chats" label="Chats" active /></NavRail>}
      bottomBar={<BottomBar><NavItem icon="chats" label="Chats" active /></BottomBar>}
    />,
  );
  expect($("aside").getAttribute("aria-label")).toBe("Conversations");
  expect($("main")).not.toBeNull();
  expect($("[data-tauri-drag-region]").getAttribute("aria-hidden")).toBe("true");
  const navs = Array.from(container().querySelectorAll("nav"));
  expect(navs).toHaveLength(2);
  expect(classes(navs[0].parentElement!)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
  expect(classes(navs[1].parentElement!)).toContain("lg:hidden");
  expect(classes(navs[1])).toContain("pb-safe");
});

it("TopBar renders a heading, a labelled back button and actions", async () => {
  const onBack = vi.fn();
  await render(<TopBar title="Linked devices" subtitle="3 devices" onBack={onBack} backOnPhoneOnly actions={<button>Add</button>} />);
  expect($("header h1").textContent).toBe("Linked devices3 devices");
  const back = $('[aria-label="Back"]');
  expect(classes(back)).toContain("sm:hidden");
  expect(classes($("header"))).toContain("pt-safe");
  await click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
});

it("TopBar title becomes a button when it opens details", async () => {
  const onTitleClick = vi.fn();
  await render(<TopBar title="Mara Lindqvist" onTitleClick={onTitleClick} />);
  expect($("h1")).toBeNull();
  await click($("header button"));
  expect(onTitleClick).toHaveBeenCalledTimes(1);
});

it("NavItem marks the current destination and exposes its unread count", async () => {
  const onClick = vi.fn();
  await render(
    <BottomBar label="Main">
      <NavItem icon="chats" label="Chats" active count={3} onClick={onClick} />
      <NavItem icon="settings" label="Settings" href="/settings" />
    </BottomBar>,
  );
  expect($("nav").getAttribute("aria-label")).toBe("Main");
  const chats = $("nav button");
  expect(chats.getAttribute("aria-current")).toBe("page");
  expect(chats.querySelector('[aria-label="3 unread"]')).not.toBeNull();
  const settings = $("nav a");
  expect(settings.getAttribute("href")).toBe("/settings");
  expect(settings.hasAttribute("aria-current")).toBe(false);
  await click(chats);
  expect(onClick).toHaveBeenCalledTimes(1);
});
