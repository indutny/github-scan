#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { splitParse, IPair, getKeysFiles, parseSSHRSAKey } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];

interface ILogEntry {
  readonly nonEmpty: boolean;
  readonly hasKeys: boolean;
}

interface IStatAcc {
  mean: number;
  stddev: number;
}

function* computeCorrelation() {
  const nonEmpty: IStatAcc = { mean: 0, stddev: 0 };
  const hasKeys: IStatAcc = { mean: 0, stddev: 0 };
  let products = 0;
  let total = 0;

  const count = (acc: IStatAcc, value: boolean) => acc.mean += value ? 1 : 0;

  for (;;) {
    const entry = (yield 0) as ILogEntry;
    if (!entry) {
      break;
    }

    count(nonEmpty, entry.nonEmpty);
    count(hasKeys, entry.hasKeys);
    products += (entry.nonEmpty && entry.hasKeys) ? 1 : 0;
    total++;
  }

  const finalize = (acc: IStatAcc) => {
    acc.mean /= total;
    acc.stddev = Math.sqrt(acc.mean * (1 - acc.mean));
  }

  finalize(nonEmpty);
  finalize(hasKeys);

  let res = (products / total) - nonEmpty.mean * hasKeys.mean;
  res /= nonEmpty.stddev * hasKeys.stddev;
  return res;
}

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

  const stats = {
    users: {
      total: 0,
      nonEmpty: 0,
      withKeys: 0,
      nonEmptyWithKeys: 0,
    },
    keys: {
      total: 0,
      categories: new Map<string, number>(),
      rsaSize: new Map<number, number>(),
    },
  };

  const correlation = computeCorrelation();

  const files = await getKeysFiles(KEYS_DIR);
  for (const file of files) {
    debug(`processing "${file}"`);
    const stream = fs.createReadStream(path.join(KEYS_DIR, file));
    for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
      stats.users.total++;

      const nonEmpty = pair.user.name || pair.user.bio || pair.user.location ||
          pair.user.email || pair.user.websiteUrl || pair.user.company;
      if (nonEmpty) {
        stats.users.nonEmpty++;
      }

      const hasKeys = pair.keys.length !== 0;
      correlation.next({ nonEmpty, hasKeys });

      if (!hasKeys) {
        continue;
      }

      stats.users.withKeys++;
      if (nonEmpty) {
        stats.users.nonEmptyWithKeys++;
      }
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

  const percentNonEmpty = (stats.users.nonEmpty * 100) / stats.users.total;
  const percentWithKeys = (stats.users.withKeys * 100) / stats.users.total;
  const percentNonEmptyWithKeys =
    (stats.users.nonEmptyWithKeys * 100) / stats.users.nonEmpty;
  const keysPerUser = stats.keys.total / stats.users.withKeys;

  console.log('Total users: %d', stats.users.total);
  console.log('Non-empty users: %s %', percentNonEmpty.toFixed(2));
  console.log('Users with SSH keys: %s %',
    percentWithKeys.toFixed(2));
  console.log('Non-empty users with SSH keys: %s %',
    percentNonEmptyWithKeys.toFixed(2));
  console.log('Keys per user with SSH keys: %s',
    keysPerUser.toFixed(2));
  console.log('Correlation non-empty user + has keys: %s',
    correlation.next(undefined).value.toFixed(2));

  console.log('Key statistics:');
  printMap(stats.keys.categories, stats.keys.total);

  console.log('RSA sizes:');
  const rsaCount = stats.keys.categories.get('ssh-rsa') || 0;
  printMap(stats.keys.rsaSize, rsaCount);
}

main().catch((e) => {
  throw e;
})
