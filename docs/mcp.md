# MCP server

Holidayys WA CRM ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so the team can drive the CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is a thin wrapper over the
[public API](./public-api.md), so every request is authenticated and scoped by
the account exactly like any other API call.

## Quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant only the
   scopes your assistant needs (a read-only assistant only needs the `*:read`
   scopes).
2. Build the server: `cd mcp-server && npm install && npm run build`.
3. Add it to your MCP client config, pointing `command` / `args` at the built
   entry point:

   ```jsonc
   {
     "mcpServers": {
       "holidayys-wa-crm": {
         "command": "node",
         "args": ["/absolute/path/to/mcp-server/dist/index.js"],
         "env": {
           "WACRM_BASE_URL": "https://wa.holidayys.co",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

That's **read-only** — the safe default. To let the assistant change data or
send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status.
- **Writes (opt-in):** send a message, create/update a contact.
- **Broadcasts (opt-in):** launch a template broadcast — requires an explicit
  `confirm` and is marked destructive.

## Safety

Because sending WhatsApp messages is a real side effect, the server is
**read-only until you opt in**, layered on top of the API key's own scopes.
Give an assistant a read-only key and read-only config and it physically cannot
send anything. See the [server README](../mcp-server/README.md) for the full
tool list and safety model.
