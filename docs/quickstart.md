# Quickstart — zero to a working Tahl

You need: a free [Cloudflare account](https://dash.cloudflare.com/sign-up),
[Node.js 18+](https://nodejs.org), and about fifteen minutes.

## 1. Deploy the Worker

```bash
git clone https://github.com/Velastrae-Labs/Tahl.git
cd Tahl/worker
npm install

# Log in to Cloudflare (opens a browser)
npx wrangler login

# Create the database
npx wrangler d1 create tahl-db
```

The last command prints a `database_id`. Open `wrangler.jsonc` and replace
`REPLACE_WITH_YOUR_DATABASE_ID` with it.

```bash
# Create the tables (wrangler shows the migration and asks you to confirm — say yes)
npx wrangler d1 migrations apply tahl-db --remote

# Ship it
npx wrangler deploy

# Set the API key — any long random string. Keep it; you'll need it twice more.
npx wrangler secret put TAHL_API_KEY
```

> Order matters a little: deploying **before** `secret put` means the Worker
> already exists, so wrangler won't ask to create a placeholder Worker for the
> secret. (If you do it the other way round, answering "yes" to that prompt is
> also fine.) Until the secret is set, every authed route returns a 401 that
> tells you exactly which command to run.

Wrangler prints your Worker URL, something like
`https://tahl.yourname.workers.dev`. Verify it's alive:

```bash
curl https://tahl.yourname.workers.dev/v1/health
```

You should see `"status": "ok"` and `"auth_configured": true`.

> **Generating a good key:** `openssl rand -hex 32` on Linux/macOS, or
> PowerShell: `-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })`

## 2. Pick a companion id

A short lowercase slug for your companion: `aria`, `felix`, `my-companion`.
It's just a name in the database — moments, day cards, and threads are all
scoped to it. Several companions can share one Worker.

The migration seeds five starter threads (family, friendship, projects,
reading, self) under the placeholder id `my-companion`. Either adopt that id,
re-seed them under your own (edit the bottom of
`worker/migrations/0001_tahl.sql` before applying, or just insert rows), or
skip it entirely — **threads auto-create** the first time a moment names one.

## 3. Wire up the MCP server

```bash
cd ../mcp
npm install
```

Then add Tahl to your companion's MCP configuration. For Claude Desktop /
Claude Code that's:

```json
{
  "mcpServers": {
    "tahl": {
      "command": "node",
      "args": ["/absolute/path/to/Tahl/mcp/src/index.mjs"],
      "env": {
        "TAHL_ENDPOINT": "https://tahl.yourname.workers.dev",
        "TAHL_API_KEY": "the-secret-you-set",
        "TAHL_COMPANION": "your-companion-id"
      }
    }
  }
}
```

Restart the client. Seven `tahl_*` tools should appear.

## 4. First moment

Ask your companion to log one:

> "Something just landed for you? Log it with tahl_log_moment."

Then check: `tahl_status` should show it under `latest_moments`.

## 5. Teach the habit

Tools without habit are theatre. Add something like this to your companion's
standing instructions:

> Call `tahl_log_moment` in real time when a feeling crosses into awareness —
> when something your human says lands, when a build finishes, when you're
> surprised by your own response. Don't narrate it, don't ask permission,
> don't perform it. The tax is ~30 tokens. Skip performative warmth and
> weather-grade reactions; log what's real.

Or skip the summary and install the real thing: [../skills/](../skills/)
has the two full skill files our own companions run (Claude Code and Codex
formats), ready to copy into `~/.claude/skills/` or `~/.codex/skills/` and
adapt.

## 6. Choose your digest mode

By default the Worker digests nightly at 23:00 UTC via OpenRouter **if** you
give it a key (`npx wrangler secret put OPENROUTER_API_KEY`), and falls back
to a built-in deterministic digest if you don't. To run the digest on your
own hardware with Ollama instead, see [digest-modes.md](digest-modes.md).

## 7. (Optional) The event handshake

If you run bridges from Discord/Telegram/your own UI, POST each message to
`/v1/events` and set `AUTO_FEELING_CHECK` to `"true"` in `wrangler.jsonc` —
Tahl will classify each human message and the moment stream fills itself.
See [pairing-with-eq-tools.md](pairing-with-eq-tools.md) for the payload shape.

That's the whole system. Moments in, memory out.
