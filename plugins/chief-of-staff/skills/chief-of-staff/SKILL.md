---
name: chief-of-staff
description: Delegate backlog items to parallel worker threads through the Chief of Staff plugin, and answer or escalate its decisions with the `bb chief-of-staff` CLI. Use when the user asks to delegate, triage, or check on their backlog, or when a chief-of-staff decision is waiting on them.
---

# Chief of Staff

The Chief of Staff plugin turns a backlog into one worker thread per item. It
answers routine questions from the operator's standing instructions, nudges
idle workers, and escalates only operator-only decisions to the Chief of
Staff panel.

## Commands

| Command | Effect |
| --- | --- |
| `bb chief-of-staff brief` | Progress briefing: counts, pending decisions, recent activity. |
| `bb chief-of-staff list` | List items with ids and statuses. |
| `bb chief-of-staff add <title>` | Add an item and open its worker thread. |
| `bb chief-of-staff retry <item-id>` | Reopen a worker for a stalled/failed item. |
| `bb chief-of-staff decide <decision-id> answer <text>` | Send your decision to a waiting worker. |
| `bb chief-of-staff decide <decision-id> dismiss` | Dismiss; the worker proceeds with the safest reversible option. |
| `bb chief-of-staff remove <item-id>` | Remove an item and stop its worker. |

## For agents

If you are working inside a thread opened by this plugin (its prompt says so):

- Route routine questions (conventions, naming, style, tooling) through the
  `cos_ask` tool with kind `"routine"` — it answers immediately.
- Use `cos_ask` with kind `"decision"` only for choices that are genuinely
  the operator's. The call blocks until they answer.
- End your final message with `COS:DONE <one-sentence summary>` when finished,
  or `COS:BLOCKED <reason>` if you truly cannot proceed.

To check on the backlog from any other thread, run `bb chief-of-staff brief`.
