import { getByLabelText } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import {
  Avatar, Badge, Button, CountBadge, EmptyState, Field, Icon, ICON_NAMES, IconButton, Input, ListItem,
  Notice, Select, Skeleton, Spinner, Textarea,
} from "./index.js";
import { click, setupDom } from "./test-utils.js";

const { render, container } = setupDom();
const $ = <T extends Element = HTMLElement>(selector: string) => container().querySelector<T>(selector)!;

it("Button defaults to type=button and fires onClick", async () => {
  const onClick = vi.fn();
  await render(<Button onClick={onClick}>Save</Button>);
  const button = $<HTMLButtonElement>("button");
  expect(button.type).toBe("button");
  expect(button.textContent).toBe("Save");
  await click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("Button in loading state is busy, disabled and keeps its label", async () => {
  const onClick = vi.fn();
  await render(<Button loading onClick={onClick}>Save</Button>);
  const button = $<HTMLButtonElement>("button");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Save");
  await click(button);
  expect(onClick).not.toHaveBeenCalled();
});

it("Button forwards its ref", async () => {
  let node: HTMLButtonElement | null = null;
  await render(<Button ref={(element) => { node = element; }}>Save</Button>);
  expect(node).toBe($("button"));
});

it("Button with href renders a styled link instead of a button", async () => {
  const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  await render(<Button href="/login" variant="secondary" leadingIcon="download" onClick={onClick}>Sign in</Button>);
  expect($("button")).toBeNull();
  const link = $<HTMLAnchorElement>("a");
  expect(link.getAttribute("href")).toBe("/login");
  expect(link.textContent).toBe("Sign in");
  expect(link.className).toContain("border-line-strong");
  expect(link.className).toContain("min-h-11");
  expect(link.querySelector("svg[data-icon='download']")).not.toBeNull();
  expect(link.hasAttribute("type")).toBe(false);
  expect(link.hasAttribute("target")).toBe(false);
  expect(link.hasAttribute("rel")).toBe(false);
  await click(link);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("Button link passes download/target and defaults rel for new tabs", async () => {
  let node: HTMLAnchorElement | null = null;
  await render(<>
    <Button href="https://example.com/a.zip" target="_blank" download="a.zip" size="lg" ref={(element) => { node = element; }}>Get</Button>
    <Button href="https://example.com/b" target="_blank" rel="noopener">Other</Button>
  </>);
  const [first, second] = Array.from(container().querySelectorAll("a"));
  expect(node).toBe(first);
  expect(first.getAttribute("target")).toBe("_blank");
  expect(first.getAttribute("rel")).toBe("noopener noreferrer");
  expect(first.getAttribute("download")).toBe("a.zip");
  expect(first.className).toContain("min-h-12");
  expect(second.getAttribute("rel")).toBe("noopener");
});

it("Button link in loading state is busy and does not navigate", async () => {
  const onClick = vi.fn();
  await render(<Button href="/x" loading onClick={onClick}>Wait</Button>);
  const link = $<HTMLAnchorElement>("a");
  expect(link.getAttribute("aria-busy")).toBe("true");
  expect(link.getAttribute("aria-disabled")).toBe("true");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(onClick).not.toHaveBeenCalled();
});

it("IconButton exposes its label as the accessible name and hides the glyph", async () => {
  await render(<IconButton icon="attach" label="Attach file" />);
  const button = $("button");
  expect(button.getAttribute("aria-label")).toBe("Attach file");
  expect(button.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
});

it("Icon is decorative by default and an image when labelled", async () => {
  await render(<><Icon name="check" /><Icon name="shield-check" label="Verified" /></>);
  const [decorative, labelled] = Array.from(container().querySelectorAll("svg"));
  expect(decorative.getAttribute("aria-hidden")).toBe("true");
  expect(decorative.hasAttribute("role")).toBe(false);
  expect(labelled.getAttribute("role")).toBe("img");
  expect(labelled.getAttribute("aria-label")).toBe("Verified");
});

it("every icon renders drawable content in the shared stroke style", async () => {
  await render(<>{ICON_NAMES.map((name) => <Icon key={name} name={name} />)}</>);
  const icons = Array.from(container().querySelectorAll("svg"));
  expect(icons).toHaveLength(ICON_NAMES.length);
  for (const icon of icons) {
    expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon.getAttribute("stroke")).toBe("currentColor");
    expect(icon.getAttribute("fill")).toBe("none");
    expect(icon.children.length, icon.getAttribute("data-icon")!).toBeGreaterThan(0);
  }
});

it("Field links label, help and error to the Input", async () => {
  await render(
    <Field label="Password" help="At least 12 characters." error="That password is not correct." required>
      <Input type="password" />
    </Field>,
  );
  const input = $<HTMLInputElement>("input");
  const label = $<HTMLLabelElement>("label");
  expect(label.htmlFor).toBe(input.id);
  expect(input.id).not.toBe("");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.required).toBe(true);
  const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
  expect(described).toEqual(["That password is not correct.", "At least 12 characters."]);
  expect($('[role="alert"]').textContent).toBe("That password is not correct.");
});

it("Field without an error leaves the control valid", async () => {
  await render(<Field label="About"><Textarea /></Field>);
  const textarea = $<HTMLTextAreaElement>("textarea");
  expect(textarea.hasAttribute("aria-invalid")).toBe(false);
  expect(textarea.hasAttribute("aria-describedby")).toBe(false);
  expect($<HTMLLabelElement>("label").htmlFor).toBe(textarea.id);
});

it("Input works standalone and accepts invalid", async () => {
  await render(<Input aria-label="Search" invalid defaultValue="abc" />);
  const input = $<HTMLInputElement>("input");
  expect(input.getAttribute("aria-label")).toBe("Search");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.value).toBe("abc");
});

it("Avatar falls back to initials and names presence", async () => {
  await render(<Avatar name="Mara Lindqvist" presence="online" />);
  const avatar = $('[role="img"]');
  expect(avatar.getAttribute("aria-label")).toBe("Mara Lindqvist, online");
  expect(avatar.textContent).toBe("ML");
  expect(avatar.querySelector("img")).toBeNull();
});

it("Avatar shows the image, then initials if it fails to load", async () => {
  await render(<Avatar name="Tomas" src="https://example.invalid/a.png" />);
  const image = $<HTMLImageElement>("img");
  expect(image.alt).toBe("");
  const { act } = await import("react");
  await act(async () => { image.dispatchEvent(new Event("error")); });
  expect($("img")).toBeNull();
  expect($('[role="img"]').textContent).toBe("T");
});

it("Badge renders its text; CountBadge caps and hides at zero", async () => {
  await render(<><Badge tone="success" icon="shield-check">Verified</Badge><CountBadge count={120} label="unread messages" /><CountBadge count={0} label="unread messages" /></>);
  expect(container().textContent).toBe("Verified99+");
  expect($(".whitespace-nowrap").textContent).toBe("Verified");
  expect(container().querySelectorAll('[aria-label="120 unread messages"]')).toHaveLength(1);
  expect(container().querySelectorAll('[aria-label="0 unread messages"]')).toHaveLength(0);
});

it("ListItem renders a button, marks selection and keeps trailing controls separate", async () => {
  const onClick = vi.fn();
  const onTrailing = vi.fn();
  await render(
    <ListItem title="Field team" subtitle="Nine at the harbour" meta="09:41" selected onClick={onClick}
      trailing={<IconButton icon="more" label="More" onClick={onTrailing} />} />,
  );
  const [row, more] = Array.from(container().querySelectorAll("button"));
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(row.textContent).toBe("Field teamNine at the harbour");
  await click(more);
  expect(onTrailing).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
  await click(row);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("ListItem renders a link when given href and plain content otherwise", async () => {
  await render(<><ListItem title="Linked devices" href="/devices" /><ListItem title="Version" subtitle="1.0" /></>);
  expect($<HTMLAnchorElement>("a").getAttribute("href")).toBe("/devices");
  expect(container().querySelectorAll("button")).toHaveLength(0);
});

it("Notice announces urgent tones as alerts and others as status", async () => {
  const onDismiss = vi.fn();
  await render(<><Notice tone="danger" onDismiss={onDismiss}>Could not load devices.</Notice><Notice title="Heads up">Info</Notice></>);
  expect($('[role="alert"]').textContent).toContain("Could not load devices.");
  expect($('[role="status"]').textContent).toBe("Heads upInfo");
  await click($('[aria-label="Dismiss"]'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("EmptyState shows title, description and action", async () => {
  await render(<EmptyState icon="chats" title="No conversations yet" description="Start one to see it here." action={<Button>New conversation</Button>} />);
  expect($("h2").textContent).toBe("No conversations yet");
  expect($("button").textContent).toBe("New conversation");
});

it("Spinner is a labelled status; Skeleton is hidden from assistive tech", async () => {
  await render(<><Spinner label="Loading devices" /><Skeleton /></>);
  expect($('[role="status"]').getAttribute("aria-label")).toBe("Loading devices");
  expect(container().lastElementChild!.getAttribute("aria-hidden")).toBe("true");
});

it("Select joins its Field label, error and help", async () => {
  await render(<Field label="Language" help="Choose a language" error="Unavailable" required><Select defaultValue="en"><option value="en">English</option></Select></Field>);
  const select = getByLabelText<HTMLSelectElement>(container(), /Language/);
  expect(select.tagName).toBe("SELECT");
  expect(select.value).toBe("en");
  expect(select.required).toBe(true);
  expect(select.getAttribute("aria-invalid")).toBe("true");
  const described = select.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
  expect(described).toEqual(["Unavailable", "Choose a language"]);
});
