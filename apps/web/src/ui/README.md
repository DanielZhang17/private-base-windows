# `src/ui` primitives

Presentational building blocks for E2EE Chat. The design rules behind them are in `docs/design/ui-spec.md`; the tokens are in `src/index.css`.

```tsx
import { Button, Field, Input, ConfirmDialog, useToast } from "../ui/index.js";
```

See everything rendered: run `npx vite` in `apps/web` and open `/ui-gallery.html` (dev only, not in the production build).

## Rules

- **Presentational only.** Nothing here imports from `services/`, `lib/`, `stores/` or `@e2ee-chat/crypto`. Data and callbacks come in as props. Keep it that way: resolve avatar URLs, format dates and read stores in the page or hook, then pass plain values down.
- **Tokens, not literals.** Style with the token utilities (`bg-surface`, `text-ink-muted`, `border-line`, `rounded-control`, `shadow-overlay`). No hex values, no `text-base-content/50`.
- **No `window.confirm` / `alert`.** Use `ConfirmDialog` and toasts.
- **Every icon-only control has a label.** `IconButton` makes `label` required.
- Tests live next to the components (`*.test.tsx`, shared helpers in `test-utils.tsx`).

## Components

### Button, IconButton

```tsx
<Button onClick={save} loading={saving}>Save</Button>
<Button variant="secondary" leadingIcon="passkey">Sign in with a passkey</Button>
<Button variant="danger-ghost" size="sm">Forget this device…</Button>
<IconButton icon="attach" label="Attach file" />
<IconButton icon="phone-off" label="End call" variant="danger" size="lg" />
```

- `variant`: `primary` (one per view), `secondary`, `ghost`, `danger`, `danger-ghost`.
- `size`: `md` is 44px. `sm` is 36px and grows to 44px on touch devices. `lg` is 48px (56px for `IconButton`, used for call controls).
- `loading` shows a spinner, sets `aria-busy` and disables the button; the label stays.
- `type` defaults to `"button"`. Pass `type="submit"` in forms.
- `href` renders a real link (`<a>`) with the identical look, for navigation such as "Sign in" or a download URL: `<Button href="/login" variant="ghost">Sign in</Button>`. It also takes `download`, `target` and `rel`; `target="_blank"` defaults `rel` to `noopener noreferrer`. `loading` on a link sets `aria-busy`/`aria-disabled` and blocks the click.

### Field, Input, Textarea

```tsx
<Field label="Password" help="At least 12 characters." error={error} required>
  <Input type="password" value={value} onChange={...}
    trailing={<IconButton icon="eye" label="Show password" size="sm" />} />
</Field>
```

`Field` generates the id and wires `label`, `aria-describedby`, `aria-invalid` and `required` into the `Input` or `Textarea` inside it. For a custom control, spread `useFieldControl()` onto it. Without a `Field`, give the input an `aria-label`. Inputs are 16px text on purpose (iOS zoom).

### Dialog, Sheet

```tsx
<Dialog open={open} onClose={() => setOpen(false)} title="Rename this device"
  footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={save}>Save</Button></>}>
  <Field label="Device name"><Input ... /></Field>
</Dialog>

<Sheet open={open} onClose={close} title="Attach">…</Sheet>
<Sheet side="end" open={open} onClose={close} title="Conversation details">…</Sheet>
```

Both are modal: focus moves in on open (first control in the body, or `initialFocusRef`), Tab is trapped, Esc and a scrim press call `onClose`, focus returns to the opener, page scroll is locked. `Dialog` is centred from 640px and slides up from the bottom on phones. `dismissible={false}` removes Esc, scrim and close button for flows that must end in an explicit choice (recovery-key reveal). Render conditionally by `open`; the component returns `null` when closed. Put buttons in `footer`, primary last.

### ConfirmDialog

```tsx
<ConfirmDialog
  open={target !== null}
  tone="danger"
  title={`Remove ${target?.name}?`}
  description="It will be signed out and will no longer receive messages."
  confirmLabel="Remove device"
  busy={removing}
  error={removeError}
  onConfirm={remove}
  onCancel={() => setTarget(null)}
/>
```

Replaces `window.confirm`. You own `open`; do the work in `onConfirm`, keep the dialog open with `busy` while it runs, show a failure with `error`, and close it yourself on success. `tone="danger"` focuses Cancel first. For irreversible loss of keys or data add `acknowledgeLabel="I understand this cannot be undone."`, which adds a checkbox that must be ticked. Extra content (a password field for account deletion) goes in `children`.

### ToastProvider, useToast, Notice

```tsx
// once, near the root
<ToastProvider><App /></ToastProvider>

const toast = useToast();
toast.show({ tone: "success", message: "Recovery key copied" });
toast.show({ tone: "danger", title: "Could not remove member", message: err.message,
  action: { label: "Retry", onClick: retry } });
```

Toasts replace `window.alert`. They auto-dismiss after 5s, except `danger`, which stays until dismissed. Up to three queued toasts can appear alongside a separate, externally timed save notice. Use a toast for the result of an action; use `Notice` for something that belongs to a place on the screen or lasts (form error summary, offline banner, "safety number changed").

```tsx
<Notice tone="warning" title="Reconnecting">Messages will send when you are back online.</Notice>
<Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}>Could not load devices.</Notice>
```

### ListItem

```tsx
<ul role="list">
  <li>
    <ListItem
      leading={<Avatar name={c.name} src={c.avatarSrc} presence="online" />}
      title={c.name} subtitle={c.preview} meta="09:41"
      trailing={<CountBadge count={c.unread} label="unread messages" />}
      selected={c.id === openId}
      onClick={() => open(c.id)}
    />
  </li>
</ul>
```

`onClick` makes the row a button, `href` a link, neither a static row. Controls in `trailing` stay separately clickable. `tone="danger"` is for destructive menu rows.

### Avatar

`<Avatar name="Mara Lindqvist" src={url} size="md" presence="online" />`. Sizes `xs` 28, `sm` 36, `md` 44, `lg` 64, `xl` 96. Falls back to initials when there is no image or it fails to load. `shape="rounded"` marks a group. `src` must already be a normal URL: resolve `r2://` and similar schemes before passing it (the existing `resolveAvatarImageUrl` does this).

### Badge, CountBadge

`<Badge tone="success" icon="shield-check">Verified</Badge>`; tones `neutral`, `brand`, `success`, `warning`, `danger`; `variant="solid"` for emphasis. `<CountBadge count={3} label="unread messages" />` renders nothing at 0 and caps at `99+`.

### AppShell, TopBar, BottomBar, NavRail, NavItem

```tsx
<AppShell
  banner={offline && <Notice tone="warning" icon="offline">You are offline.</Notice>}
  rail={<NavRail footer={<Avatar name={me.name} size="sm" />}>
          <NavItem icon="chats" label="Chats" active count={unread} onClick={goChats} />
          <NavItem icon="settings" label="Settings" onClick={goSettings} />
        </NavRail>}
  bottomBar={<BottomBar>…same NavItems…</BottomBar>}
  list={<><TopBar title="Chats" actions={…} /><ChatList /></>}
  detail={conversationOpen ? <Conversation /> : undefined}
  placeholder={<EmptyState icon="chats" title="No conversation open" />}
/>
```

- Under 640px one pane shows: `detail` when `detailActive` (defaults to "detail is set"), otherwise `list` with the bottom bar. From 640px both show. From 1024px the rail shows and the bottom bar hides.
- Safe areas: the shell pads left/right, `TopBar` pads the top, `BottomBar` pads the bottom. A composer at the bottom of a detail pane must add `pb-safe` itself.
- The shell renders the native title-bar drag strip (height `--titlebar-height`, 0 in browsers).
- `TopBar`: `onBack` adds a Back button; add `backOnPhoneOnly` in detail panes. `onTitleClick` turns the title into a button (conversation details).
- `NavItem` takes `onClick` or `href`; wire it to the router in the page.

### EmptyState, Spinner, Skeleton

```tsx
<EmptyState icon="chats" title="No conversations yet"
  description="Start one and it will appear here."
  action={<Button leadingIcon="plus">Start a conversation</Button>} />
<Spinner label="Loading devices" />
<Skeleton shape="circle" /> <Skeleton className="w-40" />
```

`Spinner` is a labelled `role="status"`; pass `label={null}` when the parent is already `aria-busy`. `Skeleton` is decorative; set `aria-busy="true"` on the region it stands in for.

### Disclosure

```tsx
<Disclosure summary="Verify download" className="border-t border-line">
  <p>…checksum and instructions…</p>
</Disclosure>
```

Show/hide section on native `<details>`/`<summary>`, so keyboard, screen-reader state and find-in-page come from the browser. The summary row is 44px tall, Small 600 in `brand`, with a `chevron-down` that turns 180° in 120ms when open. Closed by default; `defaultOpen` opens it initially and `onToggle(open)` reports changes. Use it for optional detail that most people skip, not for primary content.

### Icon

`<Icon name="shield-check" size={20} />`. Names are typed (`IconName`); the full list is `ICON_NAMES` and is shown in the gallery. Decorative by default; pass `label` only when the icon alone carries meaning. Add new icons to `icons/paths.tsx` in the same style (24 grid, 1.75 stroke, round caps, no fill).

## CSS helpers from `index.css`

| Class | Use |
|---|---|
| `bubble bubble-own` / `bubble bubble-incoming` | Message bubbles; colours come from the user-preference variables |
| `bubble-failed` | Add to a bubble that was not sent |
| `send-button-themed` | The composer send button (user-chosen colour) |
| `secret-text` | Recovery key, link code, safety number |
| `pt-safe` `pb-safe` `px-safe` `pl-safe` `pr-safe` | Safe-area padding |
| `tap-target` | Minimum 44×44 |
| `drag-region` / `no-drag` | Native window dragging |


### ActionMenu

`<ActionMenu open position={{ x, y }} title={label} items={items} onClose={close} />`
uses a z-40 popover on desktop and the modal bottom Sheet below 640px. Items have
stable `id`, `label`, `onSelect`, and optional `icon`, `hint`, `separatorBefore`,
`danger`/`disabled`. Supply `position.source`, `align`, `top` and `keyboard` for
button alignment/flipping and keyboard-first focus. Pointer openings focus the menu
container; keyboard openings focus the first item. Phone `preview` replaces the title
visually while retaining its accessible label. Arrow keys, Home/End and typeahead navigate;
Escape, outside press and Tab close; focus returns to the opener. Trigger buttons
should set `aria-haspopup="menu"` and `aria-expanded`. Keep gesture/data logic in features.
