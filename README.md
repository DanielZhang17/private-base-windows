# E2EE Chat

A browser-based, end-to-end encrypted chat application built on Cloudflare infrastructure. It supports 1:1 chat, group chat, encrypted file sharing, and voice/video calls with end-to-end encryption.

## Features

- End-to-end encrypted direct messaging with X3DH + Double Ratchet
- Encrypted group chats with Sender Keys
- Encrypted file and image sharing with client-side AES-GCM encryption
- E2EE voice/video calls with WebRTC Insertable Streams
- Zero-knowledge server storage for messages and files
- Multi-device account support with approval and recovery flows
- Timed messages plus server-side retention enforcement

## Architecture

```text
Browser (React 19)          Cloudflare Edge
| Web Crypto API       |    | Workers (Hono router) |
| libsodium            | -> | Durable Objects (WS)  |
| IndexedDB            |    | D1 (metadata only)    |
| WebRTC               |    | R2 (encrypted files)  |
|                      |    | TURN (call relay)     |
```

## Cryptographic Stack

| Feature | Protocol / Primitive |
|---------|----------------------|
| 1:1 key agreement | X3DH |
| 1:1 message encryption | Double Ratchet |
| Group message encryption | Sender Keys |
| File encryption | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| Identity & signing | Ed25519 |
| Key exchange | X25519 |
| Client key unlock | PBKDF2-SHA256, 600K iterations |
| Server password hash | PBKDF2-SHA256, 100K iterations |
| Call frame encryption | AES-GCM via Insertable Streams |

Notes:

- Client-side private key storage remains protected with PBKDF2 at 600,000 iterations.
- Server-side account password hashing is capped at 100,000 iterations because Cloudflare Workers currently reject PBKDF2 counts above 100,000.
- Stored password hashes embed the iteration count, so older hashes remain valid.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, daisyUI |
| State | Zustand, TanStack Query |
| Local storage | IndexedDB via `idb` |
| Backend | Cloudflare Workers, Hono |
| Real-time | Durable Objects |
| Database | Cloudflare D1 |
| Files | Cloudflare R2 |
| Calls | WebRTC + Cloudflare TURN |
| Workspace | pnpm workspaces |

## Prerequisites

- Node.js 18+
- pnpm
- Wrangler CLI
- A Cloudflare account

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create Cloudflare resources

```bash
wrangler login
wrangler d1 create e2ee-chat
wrangler d1 create e2ee-chat-preview
wrangler r2 bucket create e2ee-chat-files
wrangler r2 bucket create e2ee-chat-files-preview
```

### 3. Apply schema

For a brand-new database:

```bash
cd apps/api
wrangler d1 execute e2ee-chat --file=schemas/schema.sql
```

For an existing environment, also apply the migrations in `apps/api/schemas/migrations/` in order.

Current required migrations:

- `0002_multi_device_timed_messages.sql`
- `0003_calls_table.sql`
- `0004_emojis_account_controls.sql`
- `0005_retention_policy.sql`
- `0006_conversation_acceptance.sql`

Important note:

- `0006_conversation_acceptance.sql` backfills `conversation_members.accepted_at` from `joined_at`. Without it, legacy chats can appear under Requests and `POST /api/conversations/:id/accept` can fail.

### 4. Configure secrets

Set Worker secrets:

```bash
cd apps/api
wrangler secret put JWT_SECRET
wrangler secret put TURN_SECRET
```

Create `apps/api/.dev.vars` for local development:

```text
JWT_SECRET=dev-secret-change-me
TURN_SECRET=dev-turn-secret
```

### 5. Run locally

```bash
# API
cd apps/api
npx wrangler dev

# Web
cd apps/web
npx vite
```

Open [http://localhost:5173](http://localhost:5173).

## Deploy

### API

```bash
cd apps/api
npx wrangler deploy
```

### Web

```bash
cd apps/web
npx vite build
```

Then deploy `dist/` to Cloudflare Pages.

## Project Structure

```text
E2EE/
|-- packages/
|   |-- shared/          # Shared TS types, constants, validation, WS protocol
|   `-- crypto/          # Crypto primitives and helpers
`-- apps/
    |-- api/             # Cloudflare Workers backend
    |   |-- schemas/     # Base schema + migrations
    |   `-- src/
    |       |-- routes/
    |       |-- durable-objects/
    |       |-- middleware/
    |       `-- lib/
    `-- web/             # React frontend
        `-- src/
            |-- components/
            |-- db/
            |-- lib/
            |-- pages/
            |-- services/
            `-- stores/
```

## Security Model

- D1 stores ciphertext only; the server does not decrypt messages.
- R2 stores encrypted file blobs; file keys are sent only through the E2EE channel.
- Private keys never leave the device and stay encrypted at rest in IndexedDB.
- WebSocket auth uses `Sec-WebSocket-Protocol: token.<jwt>`, not `?token=...`.
- Durable Objects receive trusted internal identity headers after JWT verification at the Worker edge.

## Operational Notes

- File downloads from the dedicated API origin require CORS headers on the final binary response, not just preflight responses.
- Existing deployments must keep D1 migrations current; several production issues came from code being newer than schema state.
- Preview and production should both receive the same schema migrations when backend routes start using new columns.

## Development

See [AGENTS.md](./AGENTS.md) for repo-specific implementation notes and invariants.
