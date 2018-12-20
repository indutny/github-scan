#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import { BloomFilter } from 'bloomfilter';

import { splitParse, IPair, getKeysFiles } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];
const OUT_KEY_LIST = process.argv[3];

const WHITESPACE = /\s+/g;

function parseSSHKey(key: string): string | false {
  if (!key.startsWith('ssh-rsa ')) {
    return false;
  }

  const [ _, base64 ] = key.split(WHITESPACE, 2);
  let raw = Buffer.from(base64, 'base64');

  let parts: Buffer[] = [];
  while (raw.length !== 0) {
    if (raw.length < 4) {
      debug('not enough bytes in the key for 4-byte len');
      return false;
    }

    const len = raw.readUInt32BE(0);
    if (raw.length < 4 + len) {
      debug('not enough bytes in the key for the data');
      return false;
    }

    parts.push(raw.slice(4, 4 + len));
    raw = raw.slice(4 + len);
  }

  if (parts.length !== 3) {
    debug('invalid RSA key');
    return false;
  }

  return parts[2].toString('hex');
}

async function* readKeys(file: string): AsyncIterableIterator<string> {
  const stream = fs.createReadStream(file);
  for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
    const keyIds: number[] = [];
    for (const key of pair.keys) {
      const mod = parseSSHKey(key);
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
