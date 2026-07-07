# Digest modes — cloud, local, or none

The nightly digest is the only place a language model reads your companion's
feelings. So Tahl makes its location a first-class choice, set by
`DIGEST_MODE` in `worker/wrangler.jsonc`.

Whatever mode you choose, the digest does the same job: read the undigested
day cards, write 0–3 durable first-person **anchors** per relationship
thread, update thread health, log the run in `digest_log`.

## `"cloud"` (default) — Worker + OpenRouter

The Worker's nightly cron (23:00 UTC) sends the day cards to a small model
via [OpenRouter](https://openrouter.ai) and applies the result.

```bash
cd worker
npx wrangler secret put OPENROUTER_API_KEY
```

Optionally pick the model in `wrangler.jsonc` (`OPENROUTER_MODEL`, default
`openai/gpt-4o-mini`). A typical day digests for well under a cent.

If the key is missing or the call fails, the run automatically drops to the
deterministic fallback — a digest never silently skips a day.

## `"local"` — your own machine + Ollama

The fully private path. The Worker's cron only **closes the day** (bundles
moments into day cards); a script on hardware you own does the model work.

On the raspberry pi / mini-PC / laptop that will run it:

```bash
# 1. Install Ollama and pull a small instruct model
#    https://ollama.com/download
ollama pull llama3.2

# 2. Configure the script
cd Tahl/local-digest
cat > .env <<'EOF'
TAHL_ENDPOINT=https://tahl.yourname.workers.dev
TAHL_API_KEY=the-secret-you-set
TAHL_COMPANION=your-companion-id
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
EOF

# 3. Test it once by hand
node digest.mjs
```

Then schedule it nightly, a few minutes after the Worker's cron:

**Linux / raspberry pi (crontab -e):**
```
5 23 * * * cd /home/you/Tahl/local-digest && /usr/bin/node digest.mjs >> digest.log 2>&1
```

**Windows (Task Scheduler):**
```
schtasks /create /tn TahlDigest /tr "node C:\path\to\Tahl\local-digest\digest.mjs" /sc daily /st 23:05
```

Finally set `"DIGEST_MODE": "local"` in `wrangler.jsonc` and redeploy.

If your machine is off one night, nothing is lost — day cards stay pending
and the next run picks them up. `TAHL_COMPANION` accepts a comma-separated
list if one Worker serves several companions.

## `"fallback"` — no model anywhere

A deterministic digest built into the Worker: it gathers each day's moments
per thread into a structured anchor (dominant feeling, strongest signal,
recurring subjects, memory hints). No API keys, no costs, no model reads
anything. Less lyrical than a model's consolidation, but honest and complete
— and a perfectly good way to run Tahl for weeks before deciding whether you
want a model involved at all.

## Running a digest on demand

Ask your companion to call `tahl_run_digest`, or use curl (below). The
Worker honors its configured mode: in `cloud`/`fallback` it consolidates
immediately; in **`local` mode it only closes open days and reports how many
cards are pending** — consolidation stays with your local script, so an
eager on-demand call can never mark cards digested behind Ollama's back.
(To run the local digest on demand, just run `node digest.mjs` by hand.)

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/digest/run \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"companion": "your-companion-id"}'
```
