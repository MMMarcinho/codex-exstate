# codex-exstate

`codex-exstate` mirrors the status of a **locked Codex Plan** into a JSON file
owned by another workflow. It is useful when Codex performs the work but a
separate tool needs to display or react to the current task status.

This first version deliberately uses JSON Lines (JSONL) on standard input. It
does not connect to the Codex desktop app itself: a recorder, an App Server
forwarder, or a test script supplies `turn/plan/updated` events.

## What it guarantees

- Only an explicitly locked plan can update external state.
- A locked plan's step key, title, and order are frozen. A later structural
  change stops synchronization instead of silently updating the wrong task.
- Each plan step has a stable key, for example `[DEV.BRIDGE] Build bridge`.
- Codex statuses are mapped to the external system's status vocabulary.
- JSON state and the per-thread checkpoint are written atomically.
- An external status that is already ahead of the plan is never rolled back.

The bridge manages status only. It does not create tasks, infer plan keys, or
send events to Codex.

## Requirements

- Node.js 20 or later
- A JSON state file whose task entries already exist
- A process that can forward plan-update events as JSON Lines

There are no runtime package dependencies.

## Quick start

From the repository root:

```sh
# Optional: verify the bridge implementation.
npm test

# Create a local configuration. This command refuses to overwrite an existing file.
node src/cli.js init
```

Create the target state file and add at least one task. The default
configuration expects `.codex/exstate.json` to look like this:

```json
{
  "taskList": [
    { "nodeKey": "DEV.BRIDGE", "status": "pending" }
  ]
}
```

Lock the plan first, then send future updates to `watch`. The lock hash is the
SHA-256 hash of the ordered step keys and titles; it intentionally excludes
status. See the complete, copyable example in [the usage guide](docs/usage.md).

```sh
node src/cli.js watch --config codex-exstate.config.json < plan-events.jsonl
```

## Configuration

`node src/cli.js init` creates `codex-exstate.config.json`. Start from
[codex-exstate.config.example.json](codex-exstate.config.example.json) when
you need another file name or JSON layout.

| Field | Meaning | Default |
| --- | --- | --- |
| `stateFile` | JSON file to update | `.codex/exstate.json` |
| `checkpointFile` | Bridge-owned lock/status checkpoint | `.codex/exstate.checkpoint.json` |
| `tasksPath` | Dot-separated path to the task array | `taskList` |
| `nodeKeyField` | Task field matched with `[KEY]` | `nodeKey` |
| `statusField` | Task field written by the bridge | `status` |
| `statusMap` | Codex-to-external status mapping | `pending`, `running`, `done` |

For example, an external file using `items[].id` and `items[].phase` can be
configured with `tasksPath: "items"`, `nodeKeyField: "id"`, and
`statusField: "phase"`.

## Status behavior

By default, Codex statuses map as follows:

| Codex plan status | External status |
| --- | --- |
| `pending` | `pending` |
| `inProgress` | `running` |
| `completed` | `done` |

When a task moves directly from `pending` to `completed`, the bridge writes
`running` before `done`. This supports external systems that require the
intermediate lifecycle state. The lock event itself records the baseline only;
it does not change the state file.

## Documentation

- [Usage guide](docs/usage.md): end-to-end setup, event format, and error handling
- [Example configuration](codex-exstate.config.example.json)

## Scope and next step

The JSONL adapter is intended for recorded rollouts, POCs, and lightweight
forwarders. Integrations that must update a proprietary task system can replace
the JSON writer with a command- or API-backed writer while keeping the same
locked-plan validation rules.
