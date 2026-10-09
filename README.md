# @appscreen/mcp

MCP server for [AppScreen](https://appscreen.co) — generate App Store / Play Store screenshots from any MCP-capable agent (Claude Desktop, Claude Code, Cursor, Codex, etc.).

## Install

```bash
# Latest, no install — recommended for end users
npx -y @appscreen/mcp
```

## Configure (Claude Desktop)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appscreen": {
      "command": "npx",
      "args": ["-y", "@appscreen/mcp"],
      "env": {
        "APPSCREEN_API_KEY": "mcm_live_…"
      }
    }
  }
}
```

Omit `APPSCREEN_API_KEY` for anonymous use (5 lifetime renders, then sign-up required).

## Configure (other clients)

- **Claude Code:** `claude mcp add appscreen -- npx -y @appscreen/mcp`
- **Cursor:** `.cursor/mcp.json` — same JSON shape as above.
- **Codex:** `codex mcp add appscreen -- npx -y @appscreen/mcp`, or add to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.appscreen]
  command = "npx"
  args = ["-y", "@appscreen/mcp"]
  env = { APPSCREEN_API_KEY = "mcm_live_…" }
  ```

## Tools

- **`render_screenshots`** — Accepts screens (layout JSON) and image files. Returns a `jobId` (keyed/async) or a download link (anon/inline). Free anon use capped at 5 lifetime.
- **`get_render_status`** — Polls a `jobId`. Returns status + signed download URL when done.

### Pass images by path, not base64

The server runs locally, so give it a **file path** — it reads the bytes off disk. Do **not** base64-encode real screenshots into the call: an LLM emitting an 18k–90k-char base64 string drops a character partway down and the PNG renders black below it.

```jsonc
"files": [
  { "name": "1.png", "path": "~/app/screenshots/home.png" },   // ✅ preferred
  { "name": "2.png", "path": "/abs/path/settings.png" }
]
// base64 is accepted only for tiny synthetic test images:
// { "name": "x.png", "base64": "iVBORw0KG..." }
```

Bundle download URLs are signed and expire after ~1h. Re-poll to refresh.

## Quota

Signed-in usage is metered in **credits: 1 credit = 1 exported image** (screens × sizes × languages). A failed export is refunded; auto-translate is free. An MCP key spends the credits of the workspace it was created in.

| Plan | Credits / month | Notes |
|---|---|---|
| Free | 50 | iOS 6.9, English, 10 screens per export. 3 renders / hour. |
| Starter — $4 / mo | 400 | All 5 sizes, any 3 languages per export, auto-translate. 3 renders / hour. |
| Pro — $8 / mo | 2,500 | All 15 languages, 200 screens per export. Full-rate MCP. |
| Team — $29 / mo | 8,000 pooled | 3 seats included. Full-rate MCP. |

One-time credit packs work on every plan, including Free: 100 for $5, 400 for $15, 1,500 for $39, valid 12 months. Anonymous use (no key) is not metered in credits — it is capped at 5 renders, lifetime.

Every tool response includes `_meta.quota = {used, cap, tier, resetAt}`, plus `balance` (credits left) and, on a render submit, `cost` when the API reports them. For a signed-in caller `used` and `cap` count credits (`cap − used = balance`) and `tier` is the plan id; for an anonymous caller they count the 5 lifetime renders and `tier` is `anon-mcp`. When less than half is left the text content carries a short notice ("N credits left …"); below 20%, or at zero, the response also includes `_meta.upgradeUrl`.

An export the workspace can't cover fails with HTTP 402 `insufficient_credits` — the error text gives the cost and the balance. Full details: <https://appscreen.co/pricing>.

## Environment

| Var | Purpose |
|---|---|
| `APPSCREEN_API_KEY` | Optional. MCP key (`mcm_live_…`) from <https://appscreen.co/account/keys>. Works on every plan, Free included. Not the same as the programmatic `ask_live_…` API key. |
| `APPSCREEN_BASE_URL` | Override API URL. Defaults to `https://api.appscreen.co`. |
| `APPSCREEN_MCP_CLIENT` | Override client identifier (auto-detected from MCP initialize). |

## License

MIT
