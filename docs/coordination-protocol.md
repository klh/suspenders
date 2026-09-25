# Coordination protocol — CLAUDE.md section for a multi-agent repo

Copy this into a repo's `CLAUDE.md` (or AGENTS.md) once the control plane is
installed (`hooks/bin/coord.ts`, `hooks/lib/govdb.ts` + the keepwarm launchd
agent — see the [README](../README.md)).

## Multi-agent coordination protocol (coordinator and all lanes)

### Reporting: state changes only
Emit only **state changes**, in this shape:

```text
Δ
MERGED  lane → sha
SPAWNED lane (why)
ALERT   one line
EXIT    blocked/ok (reason)   ← only when it changed
```

Do not print unchanged fleet state, step-by-step narration, full diffs,
passing test details (`GATE: PASS` is enough — expand only on FAIL), repeated
exit reasons, "no drift" confirmations, or tool narration. **Keep cycle output
to 3–6 lines, changed fields only; expand only on ERROR/BLOCKED/DECISION.**
The database already has the details — read them when needed:

```bash
bun ~/.claude/bin/coord.ts fact set integration.head <sha> --source coordinator
bun ~/.claude/bin/coord.ts emit landed --scope <scope> --sha <sha> --as <sid>
```

### Event bus
- Checkpoint commits (every 10–20 min): `coord emit checkpoint --sha <sha> --as <sid>`
- Landings: `coord emit landed ...` + `coord fact set integration.head <sha>`
- Waiting on another lane: `coord wait --as <sid> --scope <other-scope> --max-seconds 600`
  (adaptive 250ms→2s backoff, instant wake). Prefer polling your inbox between
  items over long sleeps — W121 will make waits push-based.
- **Direct messages are interrupts-only**: STOP, CONFLICT, DEPENDENCY_CHANGED,
  NEED_DECISION. Everything else is a `coord` event/fact.
- **Cross-project traffic**: the bus is shared across repos — every `work.*`
  and `coord emit` payload carries `project`. Work numbering and shas only
  resolve inside their own repo; filter foreign `work.*` events by
  `payload.project` and verify shas against that repo.
- Retired ledgers stay as files that point at the Work Graph; do not append
  task state to them.

### Lane completion reports
The event is the report — the coordinator renders prose from it:

```bash
coord emit landed --sha <sha> --gate=pass --as <sid>       # success (unstated = normal)
coord emit landed --sha <sha> --gate=pass --artifact=fresh --driveby=row36 --as <sid>
coord emit blocked --scope <scope> --as <sid> --note "expected 28, passed 22 — cause one-liner"
```

Rendering stays terse — success needs only deviations:

```text
DONE <sha>
DONE <sha> artifact=fresh driveby=row36
BLOCKED <scope> 22/28 stitchRender host contract
```

Do not narrate implementation history, repeat test counts on success, or add
prose where a structured field exists. Exact counts go to facts/logs.

### Integration ladder
- Per-lane: cheap targeted checks
- Per-merge: qlty + affected tests, merged onto integration HEAD — a lane is
  done when the merge is green
- Final battery: once, after ~60s integration silence; mark in-flight results
  stale instead of restarting them
- Deterministic checks (build/qlty/tests) run as process jobs with results in
  `coord fact` — launch a repair agent only on FAIL
- Conflicts → repair agent in a disposable worktree; do not wake both origin
  lanes

### Cooperative preemption (pause / reroute / resume)
```bash
coord pause <sid> --reason "incoming contract change" --scope src/auth --intervention "LiveController API rewrite"
# lane hits a safe boundary → checkpoints, writes its capsule, then waits:
coord capsule set --as <sid> --task=live4 --checkpoint=91ab72c --base=f30b910 --step="rewiring host" --next="MediaMonitor bindings" --assumptions="applyPreview unchanged"
# in-band change lands, then:
coord resume <sid> --onto <new-head> --note "applyPreview: (x) → (x, ctx); MediaMonitor → factory"
```
- `coord state --as <sid>` between tool rounds: run/PAUSED + inbox count + integration HEAD. PAUSE_REQUESTED goes out as soon as the coordinator knows a collision is coming — the lane checkpoints early instead of working past the intervention.
- Continuation capsule (facts `lane.<sid>.capsule`): task, checkpoint, base, step, next, assumptions — the minimum restart packet; survives session compaction.
- Claims while paused default to SOFT (other lanes may drift in, drift-logged); hot-mark the scope only if the intervention must exclude everyone.
- PAUSE intends to continue this exact lane (capsule kept); STOP supersedes it (commits/facts remain, capsule dropped).
- resume_ready carries the delta summary — the lane updates its worktree onto the new integration HEAD, reruns targeted tests, continues. Reconciliation conflict → repair path.

- **Spawn ritual: `coord bootstrap --as <lane-sid> --role worker --parent <coordinator-sid>` for EVERY lane at spawn** — lanes need session identity (full sid, never a display truncation) so liveness sweep / orphaned / doctor-session can see them; use the SAME sid for claims and `work take`.

### Work Graph (the task database)
- Session start: `coord bootstrap --as <sid> --role coordinator|worker` → identity + OWNED + READY pool + inbox + head
- Register work: `work add <title> --scope <scope> --by <sid>` — the graph is partitioned per project (repo root)
- Take before implementing: `work take <id> --as <sid>` (CAS; a lost race is informational — pick another)
- Parallelizable? `work split <id> "t1" "t2" ... --reason independent-scopes --keep 1` — splitter keeps one child; idle lanes take from `work ready`
- Plan before fan-out: decomposition-class splits are plan-gated — one planner registers the plan as a graph item first (per-concern children, each child's exclusive file/module regions, interface contracts, integration order), child lanes `work block <child> --on <plan-id>` until the plan lands. Coupling (shared state/imports) gets discovered once by a planner instead of by N lanes; exclusive regions prevent merge wars. Splitting a never-claimed (unsurveyed) item is a drive-by fan-out — don't.
- Progress: `work done <id> --sha <sha>` — SHATTERED parents roll up automatically; scope claim auto-releases
- Ownership: `work mine --as <sid>` / `work owned` · stale owner: `work orphaned` → inspect capsule → `work reclaim <id>`
- Restart: `claude -c` auto-rebinds ownership on SessionStart (resume); verify with `coord doctor-session <sid>` — no live state may point at a closed predecessor
- Spawn gate: READY work exists + fleet under target + rate headroom + acceptable coupling → spawn; high coupling = review/test lanes, never more implementation lanes
- Keep task state in the graph, not in Markdown files

### Capability-aware dispatch (schema v2)
- Work declares needs, sessions advertise what they offer: `work add <title> --requires shell,git` · `coord bootstrap --as <sid> --caps shell,fs,git,build,mcp,vision,browser,network` — lanes inherit the parent's caps unless overridden
- `work take` refuses `requires ⊄ capabilities` — a NO-SHELL agent type cannot be dispatched shell-requiring work twice. Vocabulary: shell, fs, git, build, mcp, vision, browser, network (`CAPABILITIES` in hooks/lib/govdb.ts)
- Top-level sessions advertise the full set automatically (SessionStart); NULL on either side = legacy = no constraint

### Coordinator identity
- Exactly one coordinator identity: publish it — `coord fact set coordinator.sid <sid>` — and target that sid on the bus. Messages sent to display names instead of the published sid go nowhere.

### Zombie lanes (three-state, multi-signal)
- CLAIMED/RUNNING + session RUNNING + hb stale + transcript stale (beyond fact `fleet.zombie_after_ms`, default 45m) = **ZOMBIE**; one stale signal = **SUSPECT**; telemetry missing = **UNKNOWN**
- PAUSED / WAIT_RATE lanes are expected-silent, never zombies. Sessions blocked on an open decision are **WAITING** — surfaced separately, never swept. `monitor.ts --fix` (launchd `com.suspenders.fleet-monitor`, 15-min) detects and alerts the coordinator — it never reclaims automatically
- Remediation: `work orphaned` → reclaim → re-dispatch pointing at the frozen transcript (its context is the salvage); sessions record `transcript_path` at SessionStart so per-lane telemetry is direct

### Signalling (self-serve, inbox, checkpoints, decisions)
- Lanes self-serve: between items, poll `coord inbox --as <sid>`; if READY work matches your capabilities, take it yourself instead of waiting for dispatch
- Checkpoint every landed milestone (`work done --sha` / capsule) so preemption is a resume, not a salvage
- Decisions: `coord emit NEED_DECISION --to <target> --note "<question>"` — the fleet board lists every open decision for the owner to answer; a question that stays in an agent's context is invisible to everyone else
- Progress on long tasks: `bin/progress.ts set <id> <done> <total> [label]` — the statusline aggregates entries; these are also the lane-level progress heartbeat

### Usage windows & degradation
- 5h quota cliffs freeze whole fleets (measured 2026-09-24: staggered lane deaths 15:36–21:07, then a 6h total blackout). `bin/quota-window.ts` remembers observed 429 resets — exit 0 safe / 1 near cliff / 2 unknown; dispatch defers around the cliff and queues re-dispatch behind the reset
- Degradation path: the local LLM stack (:8901–8903, :4000 Anthropic-shim) keeps lanes running at reduced capability through a blackout — admission control prevents stalls; zombie detection catches what escapes

### Consults (questions between agents)
- Discover: `coord who-knows "query" [--scope src/x]` — ranks live sessions by recent claims / DONE work / scope touches
- Ask: `coord consult --best "<question>" [--scope s] --as <sid>` → expert inbox gets `? C## from <asker>`; reply `coord consult-reply C## "<answer>" --as <expert>` (or `--decline`)
- A consult never claims scope, never pauses a lane, never creates work. WORK = implement / CONSULT = answer / HANDOFF = take ownership. Cross-session questions use native @session messaging with who-knows for discovery.

### Claims
- Every lane registers via `claim add <sid> <scope...> --intent "..."` at spawn; shared areas get BOTH lanes' claims; hot-mark only after an observed collision
- Lanes report `{base SHA, commit SHA, changed paths, test status}` — the coordinator operates on immutable commits, never working dirs
- `claim doctor` after fleet drains

### Exit checklist (before EXIT)
- Every actionable item exists as a Work Graph item (READY/BLOCKED) — never only in prose/Markdown; every WIP patch or worktree is referenced by an item
- Claims released; state preserved in events/capsules; terse EXIT only: head, tree, work, wip, claims
- A stopped session's items stay owned until rebound or `work reclaim`ed — never silently re-queued

### Coupling rule
Deeply coupled work = ONE implementation lane + parallel review/test lanes.
4 independent lanes beat 8 coupled ones.
