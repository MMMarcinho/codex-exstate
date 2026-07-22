#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { Bridge, normalizeConfig } from './bridge.js';

function usage() {
  return 'Usage: codex-exstate init [--config path] | watch [--config path]';
}

function configPath(args) {
  const index = args.indexOf('--config');
  return index === -1 ? 'codex-exstate.config.json' : args[index + 1];
}

async function loadConfig(path) {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeConfig();
    throw error;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command || !['init', 'watch'].includes(command)) {
  console.error(usage());
  process.exitCode = 1;
} else {
  const path = configPath(args);
  if (!path) throw new Error('--config requires a path');
  if (command === 'init') {
    await writeFile(path, `${JSON.stringify(normalizeConfig(), null, 2)}\n`, { flag: 'wx' });
    console.log(`Created ${path}`);
  } else {
    const bridge = new Bridge(await loadConfig(path));
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      try {
        console.log(JSON.stringify(await bridge.handle(JSON.parse(line))));
      } catch (error) {
        console.error(JSON.stringify({ error: error.message }));
        process.exitCode = 1;
      }
    }
  }
}
