#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';

import { splitParse, IPair } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_FILE = process.argv[2];

async function main() {
  const stream = fs.createReadStream(KEYS_FILE);

  let stats = {
    users: {
      total: 0,
      withKeys: 0,
    },
    keys: {
      total: 0,
      categories: new Map<string, number>(),
    }
  };

  for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
    stats.users.total++;
    if (pair.keys.length === 0) {
      continue;
    }

    stats.users.withKeys++;
    for (const key of pair.keys) {
      stats.keys.total++;

      const [ type ] = key.split(' ', 1);
      let categoryCount: number;
      if (stats.keys.categories.has(type)) {
        categoryCount = stats.keys.categories.get(type)! + 1;
      } else {
        categoryCount = 1;
      }
      stats.keys.categories.set(type, categoryCount);
    }
  }

  console.log(stats);
}

main().catch((e) => {
  throw e;
})
