# Holidayys WA CRM

Internal WhatsApp CRM for **Holidays Tours LLC** — the tool the team uses to
run customer conversations on the official WhatsApp Business API. Built on
Next.js 16, React 19, and Convex.

Live: <https://wa.holidayys.co>

## What it does

- **Shared inbox** on the WhatsApp Business API — multiple agents on one
  number, per-conversation assignment, status, and notes.
- **Contacts** with tags and custom fields, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read tracking,
  per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new contacts,
  keywords, or a schedule; conditional branches, waits, tags, webhooks.
- **AI reply assistant** — OpenAI or Anthropic key (stored encrypted),
  AI-drafted replies in the inbox, an optional auto-reply bot with a
  knowledge base that answers from our own content.
- **Real-time dashboard** — response times, daily volume, pipeline value,
  cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys — see
  [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive the CRM from Claude, Cursor, and other AI
  assistants over the [Model Context Protocol](https://modelcontextprotocol.io).
  See [docs/mcp.md](./docs/mcp.md) (server in [`mcp-server/`](./mcp-server)).

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in Meta + encryption creds
npx convex dev                     # starts Convex, writes the Convex URLs into .env.local
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data / auth / storage** — Convex (self-hosted), `@convex-dev/auth`.
  Account-scoping (`accountQuery` / `accountMutation`, see
  `convex/lib/auth.ts`) is the tenant-isolation boundary.
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Deployment

The Next.js app is deployed on Netlify (builds from `main`) and talks to a
self-hosted Convex backend. Set the Convex + Meta environment variables
(`NEXT_PUBLIC_CONVEX_URL`, `WHATSAPP_*`, `ENCRYPTION_KEY`, …) in the Netlify
dashboard and in the Convex deployment. Security primitives: token encryption
(AES-256-GCM), account-scoped Convex queries/mutations on every tenant table,
HMAC-verified webhooks, CSP, and rate limiting.

## License

Proprietary and confidential. © 2026 Holidays Tours LLC. All rights reserved.
Internal use only — see [LICENSE](./LICENSE).
