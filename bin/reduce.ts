#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { splitParse, IPair, getKeysFiles, parseSSHRSAKey } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];

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

interface IStatsCollection {
  readonly updatedAt: Stat;
  readonly keyCount: Stat;
  readonly keySize: Stat;
}

interface IReduceEntry {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly keyCount: number;
  readonly keySize: number;
}

async function main() {
  const stats: Map<number, IStatsCollection> = new Map();

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

      let collection: IStatsCollection;
      if (stats.has(createdAt)) {
        collection = stats.get(createdAt)!;
      } else {
        collection = {
          updatedAt: new Stat(),
          keyCount: new Stat(),
          keySize: new Stat(),
        };
        stats.set(createdAt, collection);
      }

      collection.updatedAt.add(updatedAt);
      collection.keyCount.add(pair.keys.length);

      for (const key of pair.keys) {
        const rsa = parseSSHRSAKey(key);
        if (!rsa) {
          continue;
        }

        collection.keySize.add(rsa.length * 4);
      }
    }
  }

  debug('computing results');
  const result: IReduceEntry[] = [];
  for (const [ key, collection ] of stats) {
    result.push({
      createdAt: key,
      updatedAt: collection.updatedAt.mean,
      keyCount: collection.keyCount.mean,
      keySize: collection.keySize.mean,
    });
  }

  // Sort chronologically
  result.sort((a, b) => {
    return a.createdAt - b.createdAt;
  });

  console.log(JSON.stringify({
    schema: {
      createdAt: 0,
      updatedAt: 1,
      keyCount: 2,
      keySize: 3,
    },
    entries: result.map((entry) => {
      return [
        entry.createdAt, entry.updatedAt, entry.keyCount, entry.keySize,
      ];
    }),
  }));
}

main().catch((e) => {
  throw e;
})
