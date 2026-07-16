# codex-exstate

`codex-exstate` projects a locked Codex Plan's execution status into an external
JSON state file. The state-file schema is configurable, so the tool does not
depend on `.codespace/progress.json`.

## What the first version does

- Accepts `turn/plan/updated` events as JSON Lines on standard input.
- Locks a plan only when its explanation contains
  `AIMA_PLAN_LOCKED:v1:<plan-hash>`.
- Requires each plan step to start with a stable key, such as `[DEV.EVENT]`.
- Detects any post-lock structural change (key, title, or order) and stops
  synchronization.
- Maps Codex `pending` / `inProgress` / `completed` to configurable external
  statuses, writes atomically, and saves a per-thread checkpoint.

The first version deliberately uses a JSONL event adapter: it is suitable for
recorded rollouts, an App Server forwarding process, and POC testing. A direct
subscription to the Codex App connection is not assumed.

## Quick start

```sh
npm test
node src/cli.js init
```

Edit `codex-exstate.config.json` to point at any state file. By default it
expects this shape:

```json
{
  "taskList": [
    { "nodeKey": "DEV", "status": "pending" }
  ]
}
```

Lock the plan using the hash of its ordered keys and titles. Then forward plan
events as JSON Lines:

```sh
printf '%s\n' '{"method":"turn/plan/updated","params":{"threadId":"thread-1","explanation":"AIMA_PLAN_LOCKED:v1:<hash>","plan":[{"step":"[DEV] Implement bridge","status":"pending"}]}}' | node src/cli.js watch
```

Subsequent events for the same locked structure update the configured JSON
file. `completed` first writes `running` when the stored status is `pending`,
then writes `done`, preserving systems that require the intermediate state.

## Configuration

See [codex-exstate.config.example.json](./codex-exstate.config.example.json).
`tasksPath`, `nodeKeyField`, and `statusField` make the projection work with
other JSON layouts. The next integration point is a command-backed writer for
systems that require status updates through their own CLI or API.
