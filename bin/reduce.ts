#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { splitParse, IPair, getKeysFiles } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];

function formatDate(num: number): string {
  const d = new Date(num);
  const year = d.getFullYear();
  const day = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const hour = d.getHours();

  return `${year}/${month}/${day} ${hour}:00`;
}

function escapeCSV(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

class Stat {
  private readonly values: number[] = [];
  private count: number = 0;

  constructor() {
  }

  public add(value: number) {
    this.values.push(value);
    this.count++;
  }

  public get sum(): number {
    let res = 0;
    for (const value of this.values) {
      res += value;
    }
    return res;
  }

  public get mean(): number {
    return this.sum / this.count;
  }
}

interface IReduceEntry {
  readonly createdAt: number;
  readonly updatedAt: number;
};

async function main() {
  const stats: Map<number, Stat> = new Map();

  const GRANULARITY = 1000 * 3600;

  function roundTime(date: string): number {
    const time: number = new Date(date).getTime();
    return Math.floor(time / GRANULARITY) * GRANULARITY;
  }

  const files = await getKeysFiles(KEYS_DIR);
  for (const file of files) {
    debug(`processing "${file}"`);
    const stream = fs.createReadStream(path.join(KEYS_DIR, file));
    for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
      const createdAt = roundTime(pair.user.createdAt);
      const updatedAt = roundTime(pair.user.updatedAt);

      let stat: Stat;
      if (stats.has(createdAt)) {
        stat = stats.get(createdAt)!;
      } else {
        stat = new Stat();
        stats.set(createdAt, stat);
      }
      stat.add(updatedAt);
    }
  }

  debug('computing results');
  const result: IReduceEntry[] = [];
  for (const [ key, stat ] of stats) {
    result.push({ createdAt: key, updatedAt: stat.mean });
  }

  // Sort chronologically
  result.sort((a, b) => {
    return a.createdAt - b.createdAt;
  });

  process.stdout.write('created_at,updated_at\n');
  for (const entry of result) {
    const createdAt = formatDate(entry.createdAt);
    const updatedAt = formatDate(entry.updatedAt);
    process.stdout.write(`${escapeCSV(createdAt)},${escapeCSV(updatedAt)}\n`);
  }
  process.stdout.end();
}

main().catch((e) => {
  throw e;
})
