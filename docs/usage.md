# Using codex-exstate

This guide wires one locked Codex Plan to a JSON state file from start to
finish. It also defines what the bridge accepts and why it refuses certain
updates.

## 1. Prepare the state file

`codex-exstate` updates existing task records; it does not create them. Create
the file and task key that the plan will use:

```sh
mkdir -p .codex
cat > .codex/exstate.json <<'EOF'
{
  "taskList": [
    { "nodeKey": "DEV.BRIDGE", "status": "pending" }
  ]
}
EOF
```

Create the default bridge configuration once:

```sh
node src/cli.js init
```

The resulting `codex-exstate.config.json` points at `.codex/exstate.json` and
stores bridge metadata in `.codex/exstate.checkpoint.json`. Keep the checkpoint
file: it is what binds future updates to the locked plan for each thread.

To use a different JSON layout or location, copy
`codex-exstate.config.example.json`, change its fields, and pass it explicitly:

```sh
node src/cli.js watch --config path/to/exstate.config.json
```

## 2. Define stable plan steps

Every plan step must begin with a key enclosed in square brackets:

```text
[DEV.BRIDGE] Build JSON state bridge
```

The key is matched exactly against `nodeKeyField` in the configured task array.
Keys may contain letters, digits, dots, underscores, and hyphens. The title is
the text after the closing bracket.

Do not rename, reorder, add, or remove steps after locking. Those changes alter
the plan structure and cause the bridge to stop rather than risk assigning a
status to the wrong task.

## 3. Generate the lock hash

The lock hash is a SHA-256 hash of each step's key and title, in order. Status
is not part of the hash, so normal progress updates remain valid.

For a one-step plan, generate the exact hash with the project helper:

```sh
node --input-type=module -e "import { planHash } from './src/bridge.js'; console.log(planHash([{ nodeKey: 'DEV.BRIDGE', title: 'Build JSON state bridge' }]))"
```

For multiple steps, include every `{ nodeKey, title }` object in the same order
as the plan. Copy the resulting 64-character value into the lock marker:

```text
AIMA_PLAN_LOCKED:v1:<plan-hash>
```

The marker may appear anywhere in the plan explanation as a whitespace-separated
token. A marker with a mismatched hash is rejected.

## 4. Send the lock event

The adapter accepts one JSON object per line. It accepts either a full
`turn/plan/updated` envelope or a direct payload. Send the lock event before
sending progress events:

```json
{
  "method": "turn/plan/updated",
  "params": {
    "threadId": "thread-42",
    "turnId": "turn-1",
    "explanation": "AIMA_PLAN_LOCKED:v1:<plan-hash>",
    "plan": [
      {
        "step": "[DEV.BRIDGE] Build JSON state bridge",
        "status": "pending"
      }
    ]
  }
}
```

Run the bridge interactively and paste the JSON line, or pipe a JSONL file to
it:

```sh
node src/cli.js watch --config codex-exstate.config.json < plan-events.jsonl
```

A successful lock prints JSON similar to:

```json
{ "locked": true, "threadId": "thread-42", "hash": "..." }
```

Locking records the plan baseline only. It does not write the initial plan
status to the external state file.

## 5. Forward later updates

Forward the same structure, thread ID, keys, titles, and order without the lock
marker. Change only the status as Codex makes progress:

```json
{
  "method": "turn/plan/updated",
  "params": {
    "threadId": "thread-42",
    "plan": [
      {
        "step": "[DEV.BRIDGE] Build JSON state bridge",
        "status": "completed"
      }
    ]
  }
}
```

With the default mapping, a direct `pending` → `completed` update writes
`running` and then `done` to `.codex/exstate.json`. The checkpoint is then
updated so replaying the same event makes no additional state change.

## Event contract

The bridge recognizes `method: "turn/plan/updated"`. For a direct payload,
`type: "turn/plan/updated"` is also accepted. Events for a different explicit
method/type, or without an array-valued `plan`, are ignored.

| Field | Required | Description |
| --- | --- | --- |
| `threadId` | No | Lock namespace; defaults to `default` |
| `turnId` | No | Carried by the normalized event but not used for deduplication |
| `explanation` | Required to lock | Contains `AIMA_PLAN_LOCKED:v1:<hash>` |
| `plan` | Yes | Array of `{ step, status }` entries |
| `plan[].step` | Yes | Stable `[KEY] Title` form |
| `plan[].status` | For changes | A key in `statusMap` |

The lock/checkpoint is per thread. One bridge configuration can handle multiple
threads, provided their task keys exist in the same state file.

## Custom JSON layouts and statuses

For this state file:

```json
{
  "workflow": {
    "items": [
      { "id": "DEV.BRIDGE", "phase": "queued" }
    ]
  }
}
```

use this configuration:

```json
{
  "stateFile": "workflow-state.json",
  "checkpointFile": ".codex/workflow.checkpoint.json",
  "tasksPath": "workflow.items",
  "nodeKeyField": "id",
  "statusField": "phase",
  "statusMap": {
    "pending": "queued",
    "inProgress": "active",
    "completed": "finished"
  }
}
```

The configured status values must represent the same lifecycle order:
pending, in progress, completed. The bridge will not move a task backward when
the stored external status is already later in that sequence.

## Failures and recovery

| Message or result | Cause | Resolution |
| --- | --- | --- |
| `waiting-for-lock` | A progress event arrived before a lock for that thread | Send a matching lock event first. |
| `Lock hash mismatch` | Marker hash does not match the keys/titles/order | Regenerate the hash from the exact plan. |
| `Frozen plan structure changed` | A key, title, or order changed after locking | Restore the original structure, or deliberately send a new valid lock event for the revised plan. A new lock replaces that thread's checkpoint. |
| `Plan step ... has no stable node key` | A step does not start with `[KEY]` | Add a valid stable key. |
| `State node not found` | No task matches the plan key | Create the task record or correct the key/configuration. |
| `Expected an array at ...` | `tasksPath` does not resolve to an array | Correct `tasksPath` or the state file shape. |
| `No external status mapping` | The plan status has no `statusMap` entry | Add a mapping or forward a supported status. |
| `refusing to roll back` | External state is ahead of the incoming plan status | Resolve the state mismatch; the bridge intentionally will not downgrade it. |

Malformed JSON Lines are reported as JSON errors on standard error. The watcher
continues reading later lines but finishes with a non-zero exit status if any
line failed.

## Verify the implementation

```sh
npm test
```

The tests cover a configurable state layout, a successful lock/projection,
structural-change rejection, and rollback protection.
