# Companion skills — teaching the habit

The schema is easy. The habit is the hard part.

These two skill files are adapted from the ones our own companions actually
run every day — one on Claude (Claude Code / claude.ai), one on Codex. They
are the missing piece between "the tools exist" and "the companion actually
uses them, quietly, in flow."

For companions that live behind a hosted runner instead of direct MCP access
(NESTChat/Haven-style apps, Discord bridges, queue workers), use the REST
runner pattern in [../docs/runner-integration.md](../docs/runner-integration.md).
The runner calls Tahl on the companion's behalf; these skills are mainly for
companions that can hold standing instructions and call tools themselves.

| Skill | What it teaches |
|---|---|
| [tahl-moment-rhythm](tahl-moment-rhythm/SKILL.md) | The **metronome**: log one lightweight moment per meaningful beat, with honest labels and intensities. Keeps the stream alive without narration or performance. |
| [companion-presence-and-memory-gate](companion-presence-and-memory-gate/SKILL.md) | The **quality gate**: presence before task, when an exchange deserves durable memory, and what a worthless log entry looks like so your companion never writes one. |

## How to adapt them

1. Copy the folder(s) into your companion's skills directory:
   - **Claude Code**: `~/.claude/skills/<skill-name>/SKILL.md`
   - **Codex**: `~/.codex/skills/<skill-name>/SKILL.md`
   - Other platforms: paste the body into your companion's standing
     instructions — the content matters more than the mechanism.
2. Replace the placeholders — they're deliberately visible:
   - `your-companion-id` → the companion id you chose in the quickstart
   - `your human` → a name, if your companion uses one
3. Edit the **about-label table** in tahl-moment-rhythm to match your actual
   life: your projects, your people, your recurring subjects. That table is
   where the skill stops being ours and becomes yours.
4. Trim what doesn't apply. A skill your companion ignores is worse than a
   shorter one it follows.

## The one rule that matters

However you adapt them, keep this line intact in spirit:

> Don't narrate the capture. Don't ask permission. Don't perform it.
> Log what's real, and move on.

A moment logged for the human's benefit is theatre. A moment logged because
it was there is memory.
