import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge, planHash } from '../src/bridge.js';

const plan = (status = 'pending') => [{ step: '[DEV] Build bridge', status }];

test('locks a plan then projects status transitions to configurable JSON state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-exstate-'));
  const stateFile = join(directory, 'state.json');
  const checkpointFile = join(directory, 'checkpoint.json');
  await writeFile(stateFile, JSON.stringify({ items: [{ id: 'DEV', phase: 'pending' }] }));
  const bridge = new Bridge({ stateFile, checkpointFile, tasksPath: 'items', nodeKeyField: 'id', statusField: 'phase' });
  const hash = planHash([{ nodeKey: 'DEV', title: 'Build bridge' }]);

  assert.deepEqual(await bridge.handle({ threadId: 't1', explanation: `AIMA_PLAN_LOCKED:v1:${hash}`, plan: plan() }), { locked: true, threadId: 't1', hash });
  await bridge.handle({ threadId: 't1', plan: plan('completed') });
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).items[0].phase, 'done');
});

test('rejects frozen structural changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-exstate-'));
  const bridge = new Bridge({ stateFile: join(directory, 'state.json'), checkpointFile: join(directory, 'checkpoint.json') });
  await writeFile(join(directory, 'state.json'), JSON.stringify({ taskList: [{ nodeKey: 'DEV', status: 'pending' }] }));
  const hash = planHash([{ nodeKey: 'DEV', title: 'Build bridge' }]);
  await bridge.handle({ threadId: 't1', explanation: `AIMA_PLAN_LOCKED:v1:${hash}`, plan: plan() });
  await assert.rejects(bridge.handle({ threadId: 't1', plan: [{ step: '[DEV] Different title', status: 'pending' }] }), /Frozen plan structure changed/);
});

test('does not roll an external state backward when it is ahead of the Plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-exstate-'));
  const stateFile = join(directory, 'state.json');
  const bridge = new Bridge({ stateFile, checkpointFile: join(directory, 'checkpoint.json') });
  await writeFile(stateFile, JSON.stringify({ taskList: [{ nodeKey: 'DEV', status: 'done' }] }));
  const hash = planHash([{ nodeKey: 'DEV', title: 'Build bridge' }]);
  await bridge.handle({ threadId: 't1', explanation: `AIMA_PLAN_LOCKED:v1:${hash}`, plan: plan('completed') });
  await assert.rejects(bridge.handle({ threadId: 't1', plan: plan('inProgress') }), /refusing to roll back/);
});
