#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import {
  getUnorderedPairIterator, parseSSHRSAKey, countMap, printMap,
} from '../src/common';

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
  const stats = {
    users: {
      total: 0,
      nonEmpty: 0,
      withKeys: 0,
      nonEmptyWithKeys: 0,

      bioLength: 0,
      bioCount: 0,

      validUrl: 0,
      urlCount: 0,
      tld: new Map<string, number>(),
    },
    keys: {
      total: 0,
      categories: new Map<string, number>(),
      rsaSize: new Map<number, number>(),
    },
  };

  const correlation = computeCorrelation();

  for await (const pair of getUnorderedPairIterator(KEYS_DIR)) {
    stats.users.total++;

    const nonEmpty = pair.user.name || pair.user.bio || pair.user.location ||
        pair.user.email || pair.user.websiteUrl || pair.user.company;
    if (nonEmpty) {
      stats.users.nonEmpty++;
    }
    if (pair.user.bio) {
      stats.users.bioLength += pair.user.bio.length;
      stats.users.bioCount++;
    }

    if (pair.user.websiteUrl) {
      try {
        let u: URL;
        try {
          u = new URL(pair.user.websiteUrl);
        } catch {
          u = new URL(`https://${pair.user.websiteUrl}`);
        }
        stats.users.validUrl++;

        const tld = u.hostname.split('.').at(-1) ?? '';
        countMap(stats.users.tld, tld);
      } catch {
        // no-op
      }
      stats.users.urlCount++;
    }

    const hasKeys = pair.keys.length !== 0;
    correlation.next({ nonEmpty: !!nonEmpty, hasKeys });

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

  const percentNonEmpty = (stats.users.nonEmpty * 100) / stats.users.total;
  const percentWithKeys = (stats.users.withKeys * 100) / stats.users.total;
  const percentNonEmptyWithKeys =
    (stats.users.nonEmptyWithKeys * 100) / stats.users.nonEmpty;
  const keysPerUser = stats.keys.total / stats.users.withKeys;
  const avgBio = stats.users.bioLength / stats.users.bioCount;
  const validUrl = (stats.users.validUrl * 100) / stats.users.urlCount;

  console.log('Total users: %d', stats.users.total);
  console.log('Non-empty users: %s %', percentNonEmpty.toFixed(2));
  console.log('Average bio field (when present): %s', avgBio.toFixed(2));
  console.log('Users with valid url %s %', validUrl.toFixed(2));
  console.log('Users with SSH keys: %s %',
    percentWithKeys.toFixed(2));
  console.log('Non-empty users with SSH keys: %s %',
    percentNonEmptyWithKeys.toFixed(2));
  console.log('Keys per user with SSH keys: %s',
    keysPerUser.toFixed(2));
  console.log('Correlation non-empty user + has keys: %s',
    correlation.next().value.toFixed(2));

  console.log('Website TLD statistics:');
  printMap(stats.users.tld, stats.users.validUrl);

  console.log('Key statistics:');
  printMap(stats.keys.categories, stats.keys.total);

  console.log('RSA sizes:');
  const rsaCount = stats.keys.categories.get('ssh-rsa') || 0;
  printMap(stats.keys.rsaSize, rsaCount);
}

main().catch((e) => {
  throw e;
})
