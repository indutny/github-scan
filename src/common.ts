import * as fs from 'fs';
import * as debugAPI from 'debug';
import { Readable } from 'stream';

const debug = debugAPI('github-scan:common');

export const KEYS_FILE_RE = /^keys-(\d+)\.json$/;
export const KEYS_FILE_PREFIX = 'keys-';
export const KEYS_FILE_POSTFIX = '.json';

const WHITESPACE = /\s+/g;

export interface IPair {
  readonly user: {
    readonly id: number;
    readonly login: string;
    readonly name: string | null;
    readonly email: string | null;
    readonly company: string | null;
    readonly bio: string | null;
    readonly location: string | null;
    readonly websiteUrl: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly followerCount: number;
    readonly issueCount: number;
    readonly prCount: number;
    readonly repositoryCount: number;
    readonly contributedToCount: number;
    readonly organizations: ReadonlyArray<string>;
  };
  readonly keys: ReadonlyArray<string>;
}

export async function* splitParse<T>(stream: Readable,
                                     parse: (v: string) => T) {
  let buffer: string = '';
  for await (const data of stream) {
    let start: number = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xa) {
        buffer += data.slice(start, i);
        start = i + 1;
        if (buffer) {
          yield parse(buffer);
        }

        buffer = '';
      }
    }

    if (start < data.length) {
      buffer += data.slice(start);
    }
  }

  if (buffer) {
    yield parse(buffer);
  }
}

export function keysFileName(chunkId: number) {
  let chunk: string = chunkId.toString();

  while (chunk.length !== 4) {
    chunk = '0' + chunk;
  }

  return `${KEYS_FILE_PREFIX}${chunk}${KEYS_FILE_POSTFIX}`;
}

export function getKeysFileChunk(file: string): number {
  const match = file.match(KEYS_FILE_RE);
  if (!match) {
    throw new Error('Unexpected');
  }

  return parseInt(match[1], 10);
}

export async function getKeysFiles(dir: string) {
  const files = await fs.promises.readdir(dir);

  return files.filter((file) => {
    return KEYS_FILE_RE.test(file);
  }).sort();
}

export function parseSSHRSAKey(key: string): string | false {
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

  let rawKey = parts[2];

  // Skip leading zero
  if (rawKey[0] === 0) {
    rawKey = rawKey.slice(1);
  }
  return rawKey.toString('hex');
}

