import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_CONFIG = {
  stateFile: '.codex/exstate.json',
  checkpointFile: '.codex/exstate.checkpoint.json',
  tasksPath: 'taskList',
  nodeKeyField: 'nodeKey',
  statusField: 'status',
  statusMap: { pending: 'pending', inProgress: 'running', completed: 'done' },
};

export class BridgeError extends Error {}

export function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    statusMap: { ...DEFAULT_CONFIG.statusMap, ...config.statusMap },
  };
}

export function normalizePlanEvent(event) {
  const payload = event.params ?? event;
  const method = event.method ?? event.type;
  if (method && method !== 'turn/plan/updated') return null;
  const plan = payload.plan;
  if (!Array.isArray(plan)) return null;
  return {
    threadId: payload.threadId ?? 'default',
    turnId: payload.turnId,
    explanation: payload.explanation ?? '',
    plan,
  };
}

export function parsePlan(plan) {
  return plan.map((entry, index) => {
    const match = /^\[([A-Za-z0-9._-]+)]\s*(.*)$/.exec(entry.step ?? '');
    if (!match) throw new BridgeError(`Plan step ${index + 1} has no stable node key: ${entry.step}`);
    return { nodeKey: match[1], title: match[2], status: entry.status };
  });
}

export function planHash(nodes) {
  return createHash('sha256')
    .update(JSON.stringify(nodes.map(({ nodeKey, title }) => ({ nodeKey, title }))))
    .digest('hex');
}

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, part) => value?.[part], object);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export class JsonStateWriter {
  constructor(config) {
    this.config = config;
  }

  async readStatus(nodeKey) {
    const state = await readJson(this.config.stateFile, {});
    const tasks = getPath(state, this.config.tasksPath);
    if (!Array.isArray(tasks)) throw new BridgeError(`Expected an array at ${this.config.tasksPath} in ${this.config.stateFile}`);
    const task = tasks.find((candidate) => candidate[this.config.nodeKeyField] === nodeKey);
    if (!task) throw new BridgeError(`State node not found: ${nodeKey}`);
    return task[this.config.statusField];
  }

  async updateStatus(nodeKey, status) {
    const state = await readJson(this.config.stateFile, {});
    const tasks = getPath(state, this.config.tasksPath);
    if (!Array.isArray(tasks)) throw new BridgeError(`Expected an array at ${this.config.tasksPath} in ${this.config.stateFile}`);
    const task = tasks.find((candidate) => candidate[this.config.nodeKeyField] === nodeKey);
    if (!task) throw new BridgeError(`State node not found: ${nodeKey}`);
    if (task[this.config.statusField] !== status) {
      task[this.config.statusField] = status;
      await writeJson(this.config.stateFile, state);
    }
  }
}

export class Bridge {
  constructor(config, { writer } = {}) {
    this.config = normalizeConfig(config);
    this.writer = writer ?? new JsonStateWriter(this.config);
  }

  async handle(rawEvent) {
    const event = normalizePlanEvent(rawEvent);
    if (!event) return { ignored: true };
    const nodes = parsePlan(event.plan);
    const checkpoint = await readJson(this.config.checkpointFile, { threads: {} });
    const prior = checkpoint.threads[event.threadId];
    const locked = /(?:^|\s)AIMA_PLAN_LOCKED:v1:([a-f0-9]{64})(?:\s|$)/.exec(event.explanation);

    if (locked) {
      const hash = planHash(nodes);
      if (locked[1] !== hash) throw new BridgeError(`Lock hash mismatch for thread ${event.threadId}`);
      checkpoint.threads[event.threadId] = { hash, nodes, statuses: Object.fromEntries(nodes.map((node) => [node.nodeKey, node.status])) };
      await writeJson(this.config.checkpointFile, checkpoint);
      return { locked: true, threadId: event.threadId, hash };
    }

    if (!prior) return { ignored: true, reason: 'waiting-for-lock' };
    const hash = planHash(nodes);
    if (hash !== prior.hash) throw new BridgeError(`Frozen plan structure changed for thread ${event.threadId}; synchronization stopped`);

    const changes = nodes.filter((node) => prior.statuses[node.nodeKey] !== node.status);
    for (const node of changes) await this.#project(node);
    checkpoint.threads[event.threadId] = { ...prior, statuses: Object.fromEntries(nodes.map((node) => [node.nodeKey, node.status])) };
    await writeJson(this.config.checkpointFile, checkpoint);
    return { threadId: event.threadId, changes: changes.map(({ nodeKey, status }) => ({ nodeKey, status })) };
  }

  async #project(node) {
    const next = this.config.statusMap[node.status];
    if (!next) throw new BridgeError(`No external status mapping for ${node.status}`);
    const current = await this.writer.readStatus(node.nodeKey);
    if (current === next) return;
    const lifecycle = [
      this.config.statusMap.pending,
      this.config.statusMap.inProgress,
      this.config.statusMap.completed,
    ];
    if (lifecycle.indexOf(current) > lifecycle.indexOf(next)) {
      throw new BridgeError(`External state for ${node.nodeKey} (${current}) is ahead of Plan (${next}); refusing to roll back`);
    }
    if (next === 'done' && current === this.config.statusMap.pending) {
      await this.writer.updateStatus(node.nodeKey, this.config.statusMap.inProgress);
    }
    await this.writer.updateStatus(node.nodeKey, next);
  }
}
