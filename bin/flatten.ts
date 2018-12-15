#!/usr/bin/env npx ts-node
import { Readable } from 'stream';
import { Buffer } from 'buffer';
import * as fs from 'fs';

const KEYS_FILE = process.argv[2];
const OUT_USER_MAP = process.argv[3];
const OUT_KEY_LIST = process.argv[4];

const WHITESPACE = /\s+/g;

interface IKey {
  readonly id: number;
  readonly key: string;
}

interface IUser {
  readonly login: string;
}

interface IPair {
  readonly user: IUser;
  readonly keys: ReadonlyArray<IKey>;
}

async function* splitParse<T>(stream: Readable) {
  let buffer: string = '';
  for await (const data of stream) {
    let start: number = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xa) {
        buffer += data.slice(start, i);
        start = i + 1;
        if (buffer) {
          yield (JSON.parse(buffer) as T);
        }

        buffer = '';
      }
    }

    if (start < data.length) {
      buffer += data.slice(start);
    }
  }

  if (buffer) {
    yield (JSON.parse(buffer) as T);
  }
}

function parseSSHKey(key: string): string | false {
  if (!key.startsWith('ssh-rsa ')) {
    return false;
  }

  const [ _, base64 ] = key.split(WHITESPACE, 2);
  let raw = Buffer.from(base64, 'base64');

  let parts: Buffer[] = [];
  while (raw.length !== 0) {
    if (raw.length < 4) {
      throw new Error('Not enough bytes in the key for 4-byte len');
    }

    const len = raw.readUInt32BE(0);
    if (raw.length < 4 + len) {
      throw new Error('Not enough bytes in the key for the data');
    }

    parts.push(raw.slice(4, 4 + len));
    raw = raw.slice(4 + len);
  }

  if (parts.length !== 3) {
    throw new Error('Invalid RSA key');
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
  for await (const pair of splitParse<IPair>(stream)) {
    const keyIds: number[] = [];
    for (const key of pair.keys) {
      const mod = parseSSHKey(key.key);
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
