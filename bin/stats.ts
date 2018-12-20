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

  const percentWithKeys = (stats.users.withKeys * 100) / stats.users.total;
  const keysPerUser = stats.keys.total / stats.users.withKeys;

  console.log('Total users: %d', stats.users.total);
  console.log('Percent of users with SSH keys: %s %',
    percentWithKeys.toFixed(2));
  console.log('Mean number of keys per user with SSH keys: %s',
    keysPerUser.toFixed(2));

  console.log('Key statistics:');
  for (const [ category, count ] of stats.keys.categories.entries()) {
    const percent = (count * 100) / stats.keys.total;

    // Ignore outliers
    if (percent < 0.01) {
      continue;
    }

    console.log('  %s => %s %', category, percent.toFixed(2));
  }
}

main().catch((e) => {
  throw e;
})
