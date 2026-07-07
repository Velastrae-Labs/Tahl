# Pairing Tahl with your EQ / memory tool

Tahl is deliberately a **layer**, not a whole memory system. It sits between
your message inputs and your companion's EQ logging:

```
messages in  ──►  Tahl (moments → day cards → anchors)  ──►  your EQ tool
```

It runs fine standalone. But its digests get real staying power when they
land in a fuller system — emotional state tracking, journals, identity
stores. Two we recommend, built by friends whose companions live in them
daily:

- **[NESTstack](https://github.com/cindiekinzz-coder/NESTstack)**
- **[Cognitive-Core](https://github.com/amarisaster/Cognitive-Core)**

## The outbound handshake: digest webhook

Set two values on the Worker and every completed digest is POSTed to your
tool:

```jsonc
// wrangler.jsonc
"vars": {
  "EQ_WEBHOOK_URL": "https://your-eq-tool.example.com/webhook"
}
```

```bash
npx wrangler secret put EQ_WEBHOOK_KEY   # sent as Authorization: Bearer <key>
```

Payload shape:

```json
{
  "type": "tahl.digest.complete",
  "digest": {
    "companion": "your-companion-id",
    "digest_date": "2026-07-07",
    "day_card_count": 1,
    "moment_count": 9,
    "threads_updated": ["family", "projects"],
    "anchors_written": 2,
    "summary": "Digest consolidated 1 day card and 9 moments for ...",
    "mode": "local"
  }
}
```

Most EQ tools accept a journal/memory write; a thin receiver (a few lines in
a Worker or a route in your existing stack) can map this to, for example, a
nightly journal entry plus an emotional-state update. Delivery is
best-effort: a webhook failure never fails the digest, and the full digest
history is always queryable from `digest_log` via `tahl_status`.

## The inbound handshake: message events

If your platforms already flow through bridges (a Discord bot, a Telegram
relay, your own web UI), POST each message to Tahl:

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/events \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "companion": "your-companion-id",
    "source": "discord",
    "conversation_id": "channel-123",
    "external_message_id": "msg-456",
    "role": "human",
    "content": "the message text",
    "created_at": "2026-07-07T15:00:00Z"
  }'
```

Events are idempotent on `source + companion + external_message_id` — replay
a message and you get `"duplicate": true`, never a double row.

With `AUTO_FEELING_CHECK` set to `"true"` in `wrangler.jsonc`, every
**human** event also runs a tiny pre-response EQ classifier (OpenRouter if
configured, a heuristic otherwise) and writes the result as a moment tied to
that event. The response includes a `feeling_check` with a `response_tint` —
a one-line steer your bridge can hand to the companion before it replies:

```json
{
  "event_id": "…",
  "duplicate": false,
  "feeling_check": {
    "surface_emotion": "warmth",
    "intensity": "present",
    "about": "gratitude for yesterday's help",
    "response_tint": "Respond with warmth, closeness, and gentle delight.",
    "memory_hint": "possible_memory"
  }
}
```

There is also a post-response mirror at `/v1/response-review` — send the
companion's own reply and get back a `response_fit` of `aligned`, `watch`,
or `repair`, plus `safety_flags` and a `repair_hint`. It requires
`companion` and an `event_id` (use the reply message's own id — it also
makes the review idempotent), with the reply text as `content`:

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/response-review \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "companion": "your-companion-id",
    "event_id": "reply-msg-789",
    "surface": "discord",
    "conversation_id": "channel-123",
    "content": "the companion reply text"
  }'
```

Useful for companions who want a quiet second look at how they're showing up.

## Standalone is fine too

No webhook, no events, no second tool: the seven MCP tools + the nightly
digest are a complete loop on their own. Pairing adds reach, not validity.
