# board v3 — GUI spec (owner directive, 2026-09-25)

> Status: SPEC — implementation sequenced after W19 (board UI correctness) lands, as W22.
> Source of truth: this file. If implementation diverges, this spec wins or gets amended.

## Principle

The GUI centres on **your task and the coordinator's decisions**, with agent machinery available underneath.

## Views

| View | Purpose |
|---|---|
| **Overview** | Current objective, meaningful progress, results, and anything needing your attention |
| **Tasks** | Queued, active, waiting, completed, and failed work |
| **Models & routing** | Local models, cloud provider, resource use, and routing decisions |
| **Governor** | File ownership, waiting agents, missed check-ins, and recovery actions |
| **Activity** | Searchable technical events and diagnostics |

## First-run setup wizard

1. **Optimize for:** Cost, Balanced, or Speed.
2. **Primary work:** Coding, Architecture, Product, Business, Finance, or a weighted mix.
3. **Machine assessment:** Detected hardware, acceleration, and available memory.
4. **Recommended installation:** Compatible runner, Hugging Face models, download sizes, and fixed ports.
5. **Verification:** Actual inference performance and cloud connection status.

## Main screen (target layout)

```text
COORDINATOR                         Balanced ▾   Coding + Architecture ▾

Improve the settings experience
Working · 3 of 5 steps complete · No action needed

CURRENT WORK
Extract settings panels
Local coding model · Last progress: 2 minutes ago
Finished tab extraction. Running validation.
[View changes]  [Pause]

ROUTING
Local selected: suitable for this change, already loaded.
Cloud available for escalation.
[Show original / clarified prompt]

RESOURCES
Local memory: used / budget     Queue: 2 tasks
Cloud: session spending / budget

GOVERNOR
2 agents working · 3 files exclusively owned · 1 agent waiting
No conflicting writes
[Inspect ownership]

COMPLETED
✓ Reviewed current implementation
✓ Identified independent changes
```

## Changes to the existing board

- Replace the badge wall with a compact fleet summary; expand it when needed.
- Replace ambiguous `RUNNING` with **Working, Waiting, Overdue, Stalled, Recovering, Completed, Failed**.
- Show **last heartbeat and last meaningful progress separately**.
- Give overdue agents a visible countdown: "Status requested; 1 minute until revocation."
- Replace the claims log with **file → owner → waiting tasks → lease status**.
- Separate current blockers from historical blocked events.
- Move raw event streams and completed cards below active work.
- Use readable task names and elapsed times; keep IDs and raw seconds in details.

## Invariants

- Keep **Cost / Balanced / Speed** accessible throughout.
- Every routing decision has a short explanation.
- The governor visibly enforces exclusive writes and recovers stalled work automatically.
- The user should mostly supervise outcomes, not babysit agents.

## New subsystems this implies (not yet built)

- Routing decision log (which model ran what, why, cost) — new facts/tables, not derivable from today's bus.
- Resource budgets (local memory, queue depth, cloud spend) — needs a budget config + collector.
- Meaningful-progress signal distinct from heartbeat (checkpoint events already exist — extend).
- Setup wizard state (preferences: optimize-for, primary-work profile) — persisted config.
