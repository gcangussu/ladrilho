/**
 * `milestones/log.json` ([Z11-34]): a list that only grows. Appends are
 * read-modify-write under the package lock, written to a temporary name and
 * renamed ([Z11-30], [Z11-61]).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { LogEntry } from './decision.js';
import { writeJson } from './files.js';
import { LOG } from './paths.js';

export function readLog(path: string = LOG): LogEntry[] {
  if (!existsSync(path)) return [];
  const log = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(log)) throw new Error(`${path} is not a list`);
  return log as LogEntry[];
}

export function appendLog(entry: LogEntry, path: string = LOG): void {
  const log = readLog(path);
  log.push(entry);
  writeJson(path, log);
}
