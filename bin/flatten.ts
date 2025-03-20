#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import { type Readable } from 'stream';
import { BloomFilter } from 'bloomfilter';

import {
  getPairIterator, parseSSHRSAKey,
} from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIRS = process.argv.slice(2);

async function main() {
  // Calculated at: https://hur.st/bloomfilter/?n=10000000&p=1e-9&m=&k=
  //
  // 1e7 elements with 1e-9 probability of false positive
  const seen = new BloomFilter(431327627, 30);
  for (const dir of KEYS_DIRS) {
    for await (const { keys } of getPairIterator(dir)) {
      for (const key of keys) {
        const mod = parseSSHRSAKey(key);
        if (!mod) {
          continue;
        }
        if (seen.test(key)) {
          debug('duplicate modulo');
          continue;
        }

        seen.add(key);
        console.log(mod);
      }
    }
  }
}

main().catch((e) => {
  throw e;
})
