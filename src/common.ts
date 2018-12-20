import * as fs from 'fs';
import { Readable } from 'stream';

export const KEYS_FILE_RE = /^keys-(\d+)\.json$/;
export const KEYS_FILE_PREFIX = 'keys-';
export const KEYS_FILE_POSTFIX = '.json';

export interface IPair {
  readonly user: {
    readonly id: number;
    readonly login: string;
    readonly name: string | null;
    readonly email: string | null;
    readonly company: string | null;
    readonly avatarUrl: string;
    readonly bio: string | null;
    readonly location: string | null;
    readonly websiteUrl: string | null;
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
