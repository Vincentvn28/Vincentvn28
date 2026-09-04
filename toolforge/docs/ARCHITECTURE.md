# ToolForge architecture

## Why it is shaped this way

The system has to do three things at once: let strangers lend a computer safely,
route work to those computers even as they come and go, and keep a build made of
hundreds of tiny steps coherent while it happens. Each of those pushed a design
decision:

- **Machines are untrusted and unreliable.** So they never receive a database
  handle or a broadcast socket — they poll a narrow HTTP surface with a token
  that only reaches `/api/agent/*`, and every unit of work they hold is a *lease*
  that expires on its own. A machine that vanishes costs one lease, not a wedged
  queue.
- **The pool changes shape constantly.** So assignment is recomputed from scratch
  every tick rather than being a queue the agents pop from. There is no
  "assigned to a machine that no longer exists" state to repair, because the next
  tick simply picks again.
- **A tool is a dependency graph, not a script.** So the hub owns readiness and
  the agents own execution. An agent never decides what runs next; it only
  reports what happened.

Everything is Node's standard library. No database, no message broker, no
websocket library — a single JSON file, `node:http`, and long polling. That is a
deliberate ceiling: it comfortably handles a pool of dozens of machines and
thousands of tasks, which is the scale this is for, and it means somebody can
`git clone` and run it without an install step.

## Components

```
                  ┌───────────────────────── hub ─────────────────────────┐
 CLI  ──admin────▶│  routes/admin.js   routes/agent.js   routes/events.js │
 dashboard ──SSE─▶│         │                │                  │         │
                  │  ┌──────▼────────────────▼──────────────────▼──────┐  │
                  │  │  planner    scheduler    execution    registry  │  │
                  │  └──────────────────┬──────────────────────────────┘  │
                  │            state.js │ (Store: one JSON file)          │
                  └─────────────────────┼─────────────────────────────────┘
                                        │ long-poll + heartbeat
                          ┌─────────────┴─────────────┐
                       agent (machine A)        agent (machine B)
                          runner.js                runner.js
```

| Module | Responsibility |
| --- | --- |
| `hub/state.js` | Opens the store, mints the admin token, exposes typed collections. |
| `hub/core/model.js` | Document factories, status vocabularies, dispatch resolution, rollups. |
| `hub/core/planner.js` | Parses/validates tool specs; upserts the tool→team→task graph; recomputes readiness. |
| `hub/core/registry.js` | Machine lifecycle: enroll, heartbeat, capacity, staleness sweep, reliability, billing. |
| `hub/core/scheduler.js` | Picks machines, creates leases, reaps expired ones, explains its decisions. |
| `hub/core/execution.js` | Claim → run → progress → complete, plus retry/cancel and log storage. |
| `hub/core/enrollment.js` | Join codes: issue, redeem, revoke. |
| `agent/` | Capability detection, config, process runner, poll/heartbeat loop. |
| `shared/` | Store, event bus, HTTP client, logging, validation — used by both sides. |

## Data model

Five collections in one JSON document:

```
machine   id, name, owner, tokenHash, status, tags, capabilities, maxConcurrency,
          rental{pricePerMinute, currency}, stats{succeeded, failed, abandoned,
          busyMs, earnings, avgDurationMs}, lastHeartbeatAt

tool      id, key, name, status, concurrency, env,
          dispatch{mode, machineIds, requires, failoverToPool}

team      id, toolId, key, role, concurrency, env, order,
          dispatch{mode: inherit|pinned|auto|hybrid, machineIds, requires}

task      id, toolId, teamId, key, ref("team:task"), command[], shell, cwd, env,
          dependsOn[ids], dependsOnRefs[], priority, timeoutMs, maxAttempts,
          requires, machineIds, status, attempt, avoidMachineIds[],
          assignment{machineId, leaseId, assignedAt, expiresAt}, result, history[]

usage     id, machineId, taskId, toolId, outcome, durationMs, pricePerMinute, amount, at
```

`ref` is what makes re-applying a spec safe: keys identify documents, so ids —
and therefore run history, logs and stats — survive edits to the spec.

### Task states

```
pending ──deps met──▶ ready ──scheduler──▶ assigned ──agent claims──▶ running
   ▲                    ▲                      │                        │
   │                    └──── requeue ─────────┴────────────────────────┤
   │                     (lease lost, machine offline, non-zero exit,   │
   │                      while attempt < maxAttempts)                  │
   │                                                                    ▼
   └── retry ◀── failed ◀── attempts exhausted ─────────── succeeded ◀──┘
                    │
                    └──▶ every dependent task becomes blocked
```

`cancelled` is reachable from any non-terminal state, by operator action.

## Dispatch resolution

Three levels, most specific wins:

```
task.machines        overrides ──▶ team.dispatch  overrides ──▶ tool.dispatch
task.requires        merges with ─▶ team.requires merges with ─▶ tool.requires
```

`resolveDispatch(tool, team, task)` produces the effective `{mode, machineIds,
requires, failoverToPool}`, and `candidatesFor(state, task)` turns that into a
ranked list:

- **pinned** — consider only `machineIds`. Nothing else, ever.
- **hybrid** — consider `machineIds`; if none is eligible and `failoverToPool`
  is set, consider the rest of the pool.
- **auto** — consider the whole pool.

Screening drops machines that are not `online`, have no free slot, or fail the
merged `requires`. Every rejection carries a reason string, which is what
`toolforge task why` prints.

Surviving machines are scored:

```
0.50 × reliability   (tasksSucceeded + 3) / (total + 4)   — Laplace-smoothed
0.25 × capacity      freeSlots / maxConcurrency
0.15 × speed         1 / (1 + avgDurationMs / 60_000)     — 0.5 when unknown
0.10 × price         1 / (1 + pricePerMinute)
     − 1.0           if the machine is in the task's avoidMachineIds
```

The avoid penalty is a demotion, not an exclusion: a two-machine pool must still
make progress after one transient blip.

## The scheduling tick

`tick(state)` runs every second, and also synchronously after any event that
could change the answer (a task completes, a spec is applied, a tool is started):

1. `sweepStaleMachines` — heartbeat older than the timeout ⇒ `offline`.
2. `reapLeases` — for every `assigned`/`running` task: requeue it if its machine
   is gone, offline, disabled, or the lease expired.
3. `refreshTool` for each active tool — recompute `pending`/`ready`/`blocked`
   from dependency statuses, then roll the tool's own status up.
4. Sort `ready` tasks by priority, then fewest attempts, then age; for each, check
   tool and team concurrency headroom, take the top-ranked candidate, and lease it.

Leases expire at `timeoutMs + leaseGraceMs`, so a slow-but-alive agent is not
stripped of work it is still doing; the agent also extends the lease on every
progress report.

## Agent protocol

All agent traffic is POST with a machine bearer token.

| Endpoint | Purpose |
| --- | --- |
| `/api/agent/join` | **No token.** Redeem a join code; returns a machine id and its token. |
| `/api/agent/heartbeat` | Liveness plus capabilities and slot count. Returns the machine view and timing config. |
| `/api/agent/work` | Long poll. Returns work orders, transitioning them `assigned` → `running`. |
| `/api/agent/progress` | Extend the lease, append streamed output. 409 means the lease is stale — stop working. |
| `/api/agent/complete` | Final exit code, duration and log tail. |
| `/api/agent/leaving` | Drain (finish current work, take no more) or go offline. |

The long poll subscribes to `task.assigned` for its own machine and returns the
moment the scheduler assigns something, so latency is a few milliseconds without
a websocket. Claiming is guarded so that a settled poll can never mark a task
`running` that nobody is going to execute — the bug that guard prevents would
strand a task until its lease expired.

A work order carries the command, the merged environment, a working directory
(`<agent workdir>/<tool key>` unless overridden), the timeout, and the lease id.
The runner spawns it in its own process group, so a timeout or cancel kills
grandchildren too — `sh -c "sleep 30"` would otherwise outlive the shell that was
signalled and hold the task's stdio open until the lease expired.

## Consistency

The hub is single-threaded, so every mutation is atomic with respect to every
other one; there are no transactions to reason about. Durability comes from the
store: mutations are applied in memory, marked dirty, and flushed on a short
debounce as a temp-file write followed by `rename`, which is atomic on POSIX.
A crash therefore loses at most the last few hundred milliseconds of state, and
whatever it loses is recovered by the same mechanism that handles a machine
dying: leases expire, tasks return to the queue.

Task logs live outside the JSON document, at
`<dataDir>/logs/<toolId>/<taskId>.attempt-<n>.log`, so a chatty build does not
bloat the state file. The last 16 KB is also kept on the task itself as
`result.logTail`, which is what the CLI shows when the file is gone.

## Security model

| | Admin token | Machine token |
| --- | --- | --- |
| Reaches | everything except `/api/agent/*` | only `/api/agent/*` |
| Stored as | plaintext in the hub's state file | SHA-256 hash |
| Rotated by | restarting with `--admin-token` | `toolforge machine token <id>` |

Both are compared with `timingSafeEqual`. `/api/health` and `/api/agent/join` are
the only unauthenticated routes; `join` is rate-limited by the code's own use
count and expiry rather than by IP.

The threat this design does *not* address is a malicious hub: agents run whatever
commands the hub sends them. That is inherent to the product — lending a machine
is lending execution — and it is why join codes are short-lived and revocable,
and why the README says to run this on a network you control.

## Extension points

- **A different runner.** `agent/runner.js` is the only place that knows about
  processes. A container or VM backend implements the same
  `runWorkOrder(order, opts)` contract.
- **A different ranking.** `scoreMachine` in `scheduler.js` is pure and unit
  tested; changing the weights or adding a signal (geography, GPU class, an SLA
  tier) touches nothing else.
- **A different store.** `shared/store.js` exposes `Collection` with
  `get/insert/update/remove/list`. Swapping the JSON file for SQLite is a
  reimplementation of that one class.
- **Payment.** The `usage` collection is already a per-task ledger with amounts
  and currencies; settlement would read it, not recompute it.
