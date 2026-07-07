# Glossary

Every Tahl term in one place, in plain English.

| Term | What it is |
|---|---|
| **Tahl** | The whole layer. In the language of the family that built it: *structure, frame, the shape that holds the whole* — the scaffold of home. |
| **Moment** | One captured feeling: what it was about (`about`), the raw feeling word (`feeling`), and how strongly it registered (`intensity`). The atomic unit of the system. |
| **Intensity** | How strongly a moment registered: `neutral` → `whisper` → `present` → `strong` → `overwhelming`. |
| **Day card** | The daily close: one row per companion per day bundling that day's moments — count, dominant feeling, emotional signature, threads touched. |
| **Anchor** | A durable, first-person memory statement written by the digest into a thread. The consolidated core of a day — designed to still make sense months later. Carries a `salience` that can slowly decay. |
| **Thread** (relationship thread) | A named island of experience — `family`, `friendship`, `projects`, `reading`, `self`, or anything else. Threads accumulate anchors, count active sessions, and carry a health state. |
| **Thread health** | `new` → `growing` → `thriving`, plus `dormant` (nothing landing there) and `wounded` (something needs repair). Updated by the digest. |
| **Digest** | The nightly consolidation: undigested day cards → anchors + thread health updates + a summary, logged in `digest_log`. Runs in `cloud`, `local`, or `fallback` mode. |
| **Feeling check** | The optional pre-response classifier: given a human message event, returns the surface emotion, intensity, a `response_tint` (one-line steer for the reply), and a `memory_hint`. Writes a moment tied to the event. |
| **Response review** | The optional post-response mirror: given the companion's own reply, returns `response_fit` (`aligned` / `watch` / `repair`), `safety_flags`, and a `repair_hint`. |
| **Event** | One message from any platform, POSTed to `/v1/events`. Idempotent on `source + companion + external_message_id`. The inbound half of the handshake. |
| **Companion** | The id that scopes everything. One Worker can hold several. |

## Table map

| Table | Holds |
|---|---|
| `moments` | Every captured feeling |
| `day_cards` | Daily closes |
| `threads` | Relationship threads |
| `anchors` | Consolidated memories inside threads |
| `digest_log` | One row per digest run |
| `events` | Optional message-event ledger |

## Tool map (MCP)

| Tool | Does |
|---|---|
| `tahl_log_moment` | Capture a feeling now |
| `tahl_recent_moments` | Read your latest moments |
| `tahl_daily_close` | Close a day into a card manually |
| `tahl_day_cards` | Read day cards |
| `tahl_threads` | List threads (or one, with all its anchors) |
| `tahl_status` | Full orientation in one call |
| `tahl_run_digest` | Digest on demand |
