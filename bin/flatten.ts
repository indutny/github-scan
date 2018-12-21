#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import { BloomFilter } from 'bloomfilter';

import { splitParse, IPair, getKeysFiles, parseSSHRSAKey } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];
const OUT_KEY_LIST = process.argv[3];

async function* readKeys(file: string): AsyncIterableIterator<string> {
  const stream = fs.createReadStream(file);
  for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
    const keyIds: number[] = [];
    for (const key of pair.keys) {
      const mod = parseSSHRSAKey(key);
      if (!mod) {
        continue;
      }

      yield mod;
    }
  }
}

async function main() {
  const files = await getKeysFiles(KEYS_DIR);
  const out = fs.createWriteStream(OUT_KEY_LIST);

  // Calculated at: https://hur.st/bloomfilter/?n=10000000&p=1e-9&m=&k=
  //
  // 1e6 elements with 1e-9 probability of false positive
  const seen = new BloomFilter(431327627, 30);
  for (const file of files) {
    debug(`reading keys from "${file}"`);
    for await (const key of readKeys(path.join(KEYS_DIR, file))) {
      if (seen.test(key)) {
        debug('duplicate modulo');
        continue;
      }

      seen.add(key);
      out.write(key + '\n');
    }
  }
  out.end();
}

main().catch((e) => {
  throw e;
})
