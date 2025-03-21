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

const OUTPUT_FILE = process.argv[2];
const KEYS_DIRS = process.argv.slice(3);

async function main() {
  const stream = fs.createWriteStream(OUTPUT_FILE);

  let total = 0;
  let duplicates = 0;

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

        total++;
        if (seen.test(key)) {
          debug('duplicate modulo');
          duplicates++;
          continue;
        }

        seen.add(key);

        const bin = Buffer.from(mod, 'hex');
        const size = Buffer.alloc(4);
        size.writeUInt32LE(bin.byteLength);
        stream.write(size);
        stream.write(bin);
      }
    }
  }

  stream.end();

  console.log(`Total: ${total}, duplicates: ${duplicates}`);
}

main().catch((e) => {
  throw e;
})
