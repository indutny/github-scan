#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { splitParse, IPair, getKeysFiles, parseSSHRSAKey } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];

async function main() {
  function countMap<K>(map: Map<K, number>, key: K) {
    let value: number;
    if (map.has(key)) {
      value = map.get(key)! + 1;
    } else {
      value = 1;
    }
    map.set(key, value);
  }

  function printMap<K>(map: Map<K, number>, total: number) {
    const entries = Array.from(map.entries());

    entries.sort((a, b) => {
      return b[1] - a[1];
    });

    for (const [ key, count ] of entries) {
      const percent = (count * 100) / total;

      // Ignore outliers
      if (percent < 0.01) {
        continue;
      }

      console.log('  %s => %s %', key, percent.toFixed(2));
    }
  }

  let stats = {
    users: {
      total: 0,
      withKeys: 0,
    },
    keys: {
      total: 0,
      categories: new Map<string, number>(),
      rsaSize: new Map<number, number>(),
    }
  };

  const files = await getKeysFiles(KEYS_DIR);
  for (const file of files) {
    debug(`processing "${file}"`);
    const stream = fs.createReadStream(path.join(KEYS_DIR, file));
    for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
      stats.users.total++;
      if (pair.keys.length === 0) {
        continue;
      }

      stats.users.withKeys++;
      for (const key of pair.keys) {
        stats.keys.total++;

        const [ type ] = key.split(' ', 1);
        countMap(stats.keys.categories, type);

        const rsa = parseSSHRSAKey(key);
        if (rsa) {
          countMap(stats.keys.rsaSize, rsa.length * 4);
        }
      }
    }
  }

  const percentWithKeys = (stats.users.withKeys * 100) / stats.users.total;
  const keysPerUser = stats.keys.total / stats.users.withKeys;

  console.log('Total users: %d', stats.users.total);
  console.log('Users with SSH keys: %s %',
    percentWithKeys.toFixed(2));
  console.log('Keys per user with SSH keys: %s',
    keysPerUser.toFixed(2));

  console.log('Key statistics:');
  printMap(stats.keys.categories, stats.keys.total);

  console.log('RSA sizes:');
  const rsaCount = stats.keys.categories.get('ssh-rsa') || 0;
  printMap(stats.keys.rsaSize, rsaCount);
}

main().catch((e) => {
  throw e;
})
