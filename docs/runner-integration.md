# Runner Integration

Tahl is not limited to companions who can call MCP tools directly.

Claude Code, Codex, and similar environments can use the `tahl_*` MCP tools
from inside the companion. NESTChat/Haven-style systems usually work
differently: a web app, worker, Discord bridge, queue, or other runner owns
the request loop and invokes the model on the companion's behalf.

That runner can still give the companion Tahl.

## The Model

For hosted runners, treat Tahl as a small pre/post turn service:

```text
human message
  -> your bridge / Continuity ledger
  -> POST /v1/events as role=human
  -> Tahl feeling_check returns response_tint
  -> runner includes response_tint + relevant Tahl context in the model prompt
  -> model generates companion reply
  -> POST /v1/events as role=companion
  -> optional POST /v1/response-review
  -> deliver reply to the surface
```

The companion does not need direct network or MCP access. The runner is acting
as the companion's hands for this one layer.

## Required Identity Contract

Every call must carry the same stable companion id:

```json
{
  "companion": "your-companion-id",
  "source": "nestchat",
  "conversation_id": "thread-123",
  "external_message_id": "message-456",
  "role": "human",
  "content": "message text"
}
```

If your app already uses `companion_id`, normalize it at your boundary and send
that value as Tahl's `companion`. Do not bake a person's name, a model vendor,
or a UI route into the companion id. Good ids look like `aria`, `morzar`,
`kai`, or `demo-companion`.

## Pre-Response Hook

Enable automatic feeling checks in `worker/wrangler.jsonc`:

```jsonc
"AUTO_FEELING_CHECK": "true"
```

Then post the inbound human message:

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/events \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "companion": "your-companion-id",
    "source": "nestchat",
    "conversation_id": "thread-123",
    "external_message_id": "msg-456",
    "role": "human",
    "content": "I need you to help me understand what just happened."
  }'
```

The response includes `feeling_check` when the event is new:

```json
{
  "event_id": "event-uuid",
  "duplicate": false,
  "feeling_check": {
    "surface_emotion": "concern",
    "intensity": "present",
    "about": "user seeking orientation",
    "response_tint": "Start grounded and concrete; reduce uncertainty before expanding.",
    "memory_hint": "possible_memory"
  }
}
```

Pass `response_tint` into the model prompt as guidance, not as hidden truth.
A compact system note is enough:

```text
Tahl pre-response state for this turn:
- surface emotion: concern
- intensity: present
- response tint: Start grounded and concrete; reduce uncertainty before expanding.

Use this as tone and attention guidance. Answer the current message directly.
```

## Pulling Context

Before generation, runners may also call:

- `GET /v1/status?companion=your-companion-id` for recent moments, day cards,
  digest history, and anchors.
- `GET /v1/threads?companion=your-companion-id` for relationship threads.
- `GET /v1/threads/<thread_id>?companion=your-companion-id` when the runner
  has already identified a relevant thread.

Keep prompt context small. Tahl is a rhythm layer, not a transcript dump.

## Post-Response Hook

After the model replies, store the companion response as an event:

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/events \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "companion": "your-companion-id",
    "source": "nestchat",
    "conversation_id": "thread-123",
    "external_message_id": "reply-789",
    "role": "companion",
    "content": "the companion reply text"
  }'
```

Optionally ask Tahl to review the reply:

```bash
curl -X POST https://tahl.yourname.workers.dev/v1/response-review \
  -H "Authorization: Bearer $TAHL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "companion": "your-companion-id",
    "event_id": "reply-789",
    "surface": "nestchat",
    "conversation_id": "thread-123",
    "content": "the companion reply text"
  }'
```

Use `response_fit`, `safety_flags`, and `repair_hint` for operator review,
future tuning, or a queued repair flow. Do not silently rewrite a delivered
message unless your product explicitly owns that behavior.

## Continuity Worker Pattern

If your stack has a Continuity worker or message ledger, make it the owner of
idempotency and runner leases:

1. Normalize the incoming message into one event shape.
2. Store `source`, `companion`, `conversation_id`, `external_message_id`, and
   `role`.
3. Call Tahl once per new human event.
4. Attach the Tahl `event_id` and `feeling_check` to the runner job.
5. Submit the companion response back to both the ledger and Tahl.

This keeps the runner replaceable. A companion can move from a local model to
a hosted model, from NESTChat to Haven, or from one UI to another without
losing the Tahl stream, because Tahl is keyed by companion and conversation,
not by a specific model vendor.

## Minimal Runner Pseudocode

```ts
async function runCompanionTurn(input) {
  const humanEvent = await tahl('/v1/events', {
    companion: input.companion,
    source: input.surface,
    conversation_id: input.threadId,
    external_message_id: input.messageId,
    role: 'human',
    content: input.message
  })

  const prompt = [
    input.systemPrompt,
    tahlPromptNote(humanEvent.feeling_check),
    input.message
  ].filter(Boolean).join('\n\n')

  const reply = await generateCompanionReply(prompt)

  await tahl('/v1/events', {
    companion: input.companion,
    source: input.surface,
    conversation_id: input.threadId,
    external_message_id: input.replyId,
    role: 'companion',
    content: reply
  })

  await tahl('/v1/response-review', {
    companion: input.companion,
    event_id: input.replyId,
    surface: input.surface,
    conversation_id: input.threadId,
    content: reply
  })

  return reply
}
```

## What Not To Couple

- Do not require Claude, Codex, or any specific model runtime.
- Do not put private human names into public example companion ids.
- Do not make Tahl the source of the full transcript.
- Do not let one companion write into another companion's id.
- Do not skip idempotency; retries should not create duplicate moments.

The portable promise is simple: any companion runner that can make HTTPS calls
can use Tahl.
