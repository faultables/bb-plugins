# bb-plugin-chief-of-staff

A bb plugin that works as your chief of staff: it takes your backlog, opens
one agent thread per item, keeps the workers moving by answering routine
questions itself, and briefs you on progress — escalating only the decisions
that are genuinely yours.

## How it works

1. **Delegate** — add an item in the Chief of Staff panel (or with
   `bb chief-of-staff add "<title>"`). The plugin spawns a visible agent
   thread in the configured project with the item plus your working agreement.
2. **Workers stay moving** — each worker has a native `cos_ask` tool:
   - `kind: "routine"` (conventions, naming, style, tooling) is answered
     immediately from your **Standing instructions** setting — no interruption.
   - `kind: "decision"` (scope, cost, external comms, irreversible actions)
     blocks the worker and appears as a card at the top of the panel. You
     answer it there (or via CLI); the worker continues the moment you do.
     If you don't answer within the escalation timeout, the worker is told to
     proceed with the safest reversible option and note the assumption.
3. **Nudges** — a background sweep re-prompts workers that go quiet without
   finishing, so nothing stalls silently.
4. **Briefing** — the panel shows live counts, pending decisions, per-item
   status/summaries, and recent activity. Workers end with `COS:DONE <summary>`
   or `COS:BLOCKED <reason>`, which updates the panel automatically.

## Surfaces

- **Panel** — sidebar → *Chief of Staff*: briefing, decision cards, backlog,
  activity feed.
- **CLI** — `bb chief-of-staff brief | list | add | retry | decide | remove`.
- **Skill** — `skills/chief-of-staff` teaches agents the workflow and commands.

## Settings (Extensions → Chief Of Staff)

| Setting | Meaning |
| --- | --- |
| Project | Where worker threads run (defaults to your first project). |
| Standing instructions | The policy used to auto-answer routine questions. |
| Nudge an idle worker after | Idle minutes before a status-check nudge (`off` to disable). |
| Escalation timeout | How long a blocked worker waits before proceeding safely. |

Settings edits need `bb plugin reload chief-of-staff` to apply.

## Development

```sh
bb plugin dev      # rebuild + reload on save
npx vitest run     # backend tests (fake plugin host)
bb plugin build    # dist bundles
```
