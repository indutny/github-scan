#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';

import { splitParse, IPair } from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_FILE = process.argv[2];
const OUT_USER_MAP = process.argv[3];
const OUT_KEY_LIST = process.argv[4];

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

async function main() {
  const stream = fs.createReadStream(KEYS_FILE);
  const out = {
    userMap: fs.createWriteStream(OUT_USER_MAP),
    keyList: fs.createWriteStream(OUT_KEY_LIST),
  };

  const keyMap: Map<string, number> = new Map();
  for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
    const keyIds: number[] = [];
    for (const key of pair.keys) {
      const mod = parseSSHKey(key);
      if (!mod) {
        continue;
      }

      let keyId: number;
      if (keyMap.has(mod)) {
        keyId = keyMap.get(mod)!;
      } else {
        keyId = keyMap.size;
        keyMap.set(mod, keyId);
        out.keyList.write(mod + '\n');
      }
      keyIds.push(keyId);
    }
    if (keyIds.length === 0) {
      continue;
    }
    out.userMap.write(`${pair.user.login},${keyIds.join(':')}\n`);
  }
  out.keyList.end();
  out.userMap.end();
}

main().catch((e) => {
  throw e;
})
