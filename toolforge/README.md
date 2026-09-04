# ToolForge

Rent your computer out as a build worker, and build tools on a pool of those
machines — one orchestrator, many apps, split into teams of micro-tasks.

*[Tiếng Việt →](README.vi.md)*

```
   your laptop ─┐
 a friend's PC ─┼─▶  hub  ─▶  tool ─▶ team ─▶ micro-task ─▶ back to any free machine
  an office box ┘         (schedules, leases, fails over, bills)
```

Three pieces, no dependencies, plain Node.js:

| Piece | What it is |
| --- | --- |
| **hub** | The scheduler and API. Holds the machine pool, the tools, and the queue. |
| **agent** | Installed on a machine that is being rented out. Polls for work, runs it, streams logs back. |
| **cli** | `toolforge` — everything else: enroll machines, apply tool specs, watch progress. |

## Install

```bash
git clone https://github.com/Vincentvn28/Vincentvn28.git
cd Vincentvn28/toolforge
node bin/toolforge.js --version      # no npm install needed; Node >= 20.11
npm link                             # optional: puts `toolforge` on your PATH
```

## Quickstart

**1. Start the hub** (on whichever machine coordinates the work):

```bash
toolforge hub start
# dashboard   http://127.0.0.1:7373
# admin token tfk_…                  ← the CLI on this machine saves it for you
```

**2. Rent machines in.** Create a join code and share it:

```bash
toolforge invite create --label "my team" --price 0.02
# code  join_7a5547a9f976
```

On each machine that wants to lend capacity:

```bash
toolforge agent join --hub http://hub-host:7373 --code join_7a5547a9f976 \
  --name lab-pc --slots 3
# detects cpus, memory and installed toolchains, then starts working
```

Ctrl+C drains cleanly: the machine finishes what it started and stops taking new work.

If you'd rather mint the token yourself, `toolforge machine add --name lab-pc` prints
one and the machine runs `toolforge agent start --hub … --token …`.

**3. Describe a tool** — teams, and the micro-tasks each team owns:

```jsonc
{
  "key": "invoice-app",
  "dispatch": { "mode": "hybrid" },
  "teams": [
    { "key": "backend", "concurrency": 4, "tasks": [
        { "key": "model",  "run": "echo model > src/model.js" },
        { "key": "create", "run": "echo create > src/create.js", "dependsOn": ["model"] },
        { "key": "list",   "run": "echo list > src/list.js",     "dependsOn": ["model"] }
    ]},
    { "key": "qa", "tasks": [
        { "key": "lint", "run": "node --check src/model.js", "dependsOn": ["backend:create", "backend:list"] }
    ]}
  ]
}
```

**4. Run it:**

```bash
toolforge tool lint  -f spec.json       # validate offline — deps, cycles, commands
toolforge tool apply -f spec.json --start
toolforge watch                         # live event stream
toolforge tool show invoice-app         # per-team progress
```

`backend:create` and `backend:list` run at the same time on different machines
the moment `backend:model` succeeds. `qa:lint` waits for both.

## Choosing where work runs

Every tool — and every team, and every individual task — picks one of three
dispatch modes:

| Mode | Behaviour |
| --- | --- |
| `pinned` | Runs **only** on the machines you attach. If they all go offline, the task waits for them. |
| `auto` | Runs anywhere in the pool. **If a machine drops out mid-task, another one picks it up.** |
| `hybrid` | Prefers your pinned machines; falls back to the pool when they are busy or offline. |

```bash
toolforge tool set invoice-app --mode pinned --machines mch_abc,mch_def
toolforge tool set invoice-app --mode hybrid                 # pinned first, pool as backup
toolforge tool set invoice-app --mode pinned --no-failover   # wait for those machines, never spill
```

A team overrides its tool (`"dispatch": { "mode": "pinned", "machines": [...] }`),
and a task overrides its team (`"machines": ["mch_abc"]`). Anything left as
`inherit` follows the level above.

### How failover actually works

1. Every agent heartbeats. Miss the window (45s by default) and the hub marks the
   machine `offline`.
2. Each running task holds a **lease**. When the machine goes offline — or the
   lease expires, or the agent reports a failure — the task returns to the queue
   with its attempt counter bumped.
3. The machine that dropped it is added to the task's `avoidMachineIds`, so the
   scheduler ranks it last on the retry. Another machine takes the task.
4. After `maxAttempts` the task is `failed`, and everything downstream of it is
   marked `blocked` rather than run against a broken dependency.

Nothing is lost when a laptop closes mid-build; the work moves.

### Which machine gets picked

In `auto` and `hybrid`, eligible machines are ranked on reliability (smoothed, so
a new machine isn't punished for having no history), free capacity, observed
speed, and rental price. Machines are eligible only if they satisfy the task's
requirements:

```jsonc
"requires": {
  "os": "win32", "arch": "x64",
  "tags": ["gpu"], "tools": ["node", "docker"],
  "minMemGb": 8, "minCpus": 4
}
```

When something isn't running and you want to know why:

```bash
toolforge task why tsk_abc123
#   runnable now   no
#   Blocked by
#    - backend:model is running
#   Machines ruled out
#    old-laptop   missing tool "docker"
#    win-box      os win32 != linux
```

## Renting: what the machine owner sees

```bash
toolforge agent capabilities   # what this machine advertises
toolforge agent status         # slots in use, reliability, earnings
toolforge earnings --detail    # per-machine ledger, billed by busy minute
```

Price is per busy minute (`--price 0.02`), set when the machine joins and
adjustable later with `toolforge machine set <id> --price`. Billing counts real
task time, including runs that failed or were abandoned — those are recorded
separately so you can tell a slow machine from an unreliable one.

The machine's owner is in charge of how much of it is lent: `--slots` on the
agent is authoritative once it connects. `toolforge machine set <id> --status draining`
lets a machine finish its current work and stop taking more.

## Dashboard

The hub serves a live dashboard at its root: pool state, per-team task tables,
and a streaming event feed. It asks for the admin token once
(`toolforge hub token`) and keeps it in the browser.

## Command reference

```
toolforge hub start [--port 7373] [--host 0.0.0.0] [--data-dir DIR]
toolforge hub token                          print the admin token
toolforge login --hub URL --token TOKEN      point this CLI at a remote hub

toolforge invite create [--label L] [--max-uses N] [--price P] [--tags a,b]
toolforge invite ls | revoke ID
toolforge agent join --hub URL --code CODE [--name N] [--slots N] [--price P]
toolforge agent start [--hub URL] [--token T] [--slots N]
toolforge agent status | capabilities

toolforge machine ls | show ID | rm ID
toolforge machine add --name N [--tags a,b] [--slots N] [--price P]
toolforge machine set ID [--tags a,b] [--slots N] [--price P] [--status draining]
toolforge machine token ID                   rotate that machine's token
toolforge earnings [--detail]

toolforge tool lint  -f spec.json
toolforge tool apply -f spec.json [--start] [--force]
toolforge tool ls | show KEY | rm KEY
toolforge tool set KEY --mode pinned|auto|hybrid [--machines a,b] [--no-failover]
toolforge tool start|pause|resume|cancel|retry KEY

toolforge task ls [--tool KEY] [--status running] [--machine ID]
toolforge task show ID | log ID | why ID | retry ID | cancel ID

toolforge status                             one-screen overview
toolforge watch                              live event stream
```

Every command takes `--json` for scripting, plus `--hub` and `--token` to target
a hub other than the saved one.

## Tool spec reference

| Field | Where | Meaning |
| --- | --- | --- |
| `key` | tool, team, task | Stable identifier. Re-applying a spec upserts by key, so task history survives. |
| `run` / `argv` | task | `run` is a shell string; `argv` is an exec array (no shell). One is required. |
| `dependsOn` | task | `"other-task"` inside the team, or `"team:task"` across teams. Cycles are rejected. |
| `concurrency` | tool, team | How many of its tasks may run at once. |
| `timeoutMs` | task | The agent kills the process group when this passes; the task fails with exit 124. |
| `maxAttempts` | task | Total tries across all machines before it fails for good. Default 3. |
| `requires` | tool, team, task | Machine requirements. They stack: tool + team + task. |
| `machines` | tool, team, task | Pinned machine ids. The most specific level wins. |
| `env` | tool, team, task | Merged tool → team → task, plus `TOOLFORGE_TASK_REF` and friends. |
| `failoverToPool` | tool, team | Whether a pinned task may spill into the shared pool. Default true. |

Working examples: [`examples/hello-tool.json`](examples/hello-tool.json) (3 tasks)
and [`examples/web-app-tool.json`](examples/web-app-tool.json) (5 teams, 12 tasks).

## Security notes

- Two kinds of credential: one **admin token** for the control API and the
  dashboard, and one **machine token** per agent. A machine token can only reach
  `/api/agent/*` — it cannot read the pool or touch other machines' work.
- Only token hashes are stored; the plaintext is shown once at creation and never
  returned by any endpoint. Rotate with `toolforge machine token <id>`.
- Join codes can be limited by use count and lifetime, and revoked at any time.
- **Agents execute the commands in your tool specs.** Renting a machine in means
  trusting whoever controls the hub. Run the hub on a network you control; it
  binds to `127.0.0.1` unless you pass `--host`, and it speaks plain HTTP, so put
  a TLS terminator in front of it before exposing it to the internet.

## Architecture and development

Design notes, the data model and the HTTP protocol are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```bash
npm test        # 43 tests: unit, HTTP integration, and real agent end-to-end runs
```

MIT licensed.
