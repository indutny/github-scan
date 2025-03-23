import * as fs from 'fs';
import * as debugAPI from 'debug';
import { join } from 'path';
import { Readable, PassThrough } from 'stream';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { createDecompressor } from 'lzma-native';
import { z } from 'zod';

const debug = debugAPI('github-scan:common');

export const KEYS_FILE_RE = /^keys-(\d+)\.json(\.xz)?$/;
export const KEYS_FILE_PREFIX = 'keys-';
export const KEYS_FILE_POSTFIX = '.json';

const WHITESPACE = /\s+/g;

export const PairSchema = z.object({
  user: z.object({
    id: z.number(),
    login: z.string(),
    name: z.string().or(z.null()),
    email: z.string().or(z.null()),
    company: z.string().or(z.null()),
    bio: z.string().or(z.null()),
    location: z.string().or(z.null()),
    websiteUrl: z.string().or(z.null()),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  keys: z.string().array(),
});

export type Pair = z.infer<typeof PairSchema>;

export async function* splitParse(
  stream: Readable,
): AsyncIterableIterator<Pair> {
  let buffer: string = '';
  for await (const data of stream) {
    let start: number = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xa) {
        buffer += data.slice(start, i);
        start = i + 1;
        if (buffer) {
          yield PairSchema.parse(JSON.parse(buffer));
        }

        buffer = '';
      }
    }

    if (start < data.length) {
      buffer += data.slice(start);
    }
  }

  if (buffer) {
    yield PairSchema.parse(JSON.parse(buffer));
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

export async function getKeysStreams(
  dir: string,
): Promise<Array<() => Readable>> {
  const files = await getKeysFiles(dir);

  return files.map(file => {
    return () => {
      const fullPath = join(dir, file);

      let result: Readable = fs.createReadStream(fullPath);
      if (!file.endsWith('.xz')) {
        return result;
      }

      const xz = createDecompressor();
      result.pipe(xz);
      return xz;
    };
  });
}

export async function* getPairIterator(
  dir: string,
): AsyncIterableIterator<Pair> {
  const files = await getKeysStreams(dir);
  for (const [i, createStream] of files.entries()) {
    debug(`processing "${dir}:${i}"`);
    const stream = createStream();
    for await (const pair of splitParse(stream)) {
      yield pair;
    }
  }
}

const BUFFER_SIZE = 1024;

export function getUnorderedPairIterator(
  dir: string,
): AsyncIterableIterator<Pair> {
  const workers = new Map<Worker, Array<Pair>>();

  const buffer = new Array<Pair>();

  let resume: (() => void) | undefined;

  let remaining = cpus().length;
  for (let i = 0; i < remaining; i++) {
    const worker = new Worker(join(__dirname, 'worker.ts'), {
      execArgv: ['-r', 'ts-node/register'],
      workerData: {
        dir,
        index: i,
        workerCount: remaining,
        bufferSize: BUFFER_SIZE,
      },
    });

    workers.set(worker, buffer);

    worker.on('message', (page: Array<Pair>) => {
      if (page.length === 0) {
        remaining--;
      }

      if (resume !== undefined) {
        const fn = resume;
        fn();
        resume = undefined;
      }

      for (const pair of page) {
        buffer.push(pair);
      }
    });
  }

  const next = async (): Promise<IteratorResult<Pair>> => {
    while (buffer.length === 0) {
      if (remaining === 0) {
        return { value: undefined, done: true };
      }

      await new Promise<void>(resolve => {
        resume = resolve;
      });
    }

    const value = buffer.shift();
    if (value === undefined) {
      throw new Error('Unexpected');
    }
    return { value, done: false };
  };

  const res = {
    next,
    [Symbol.asyncIterator]() {
      return res;
    },
  };

  return res;
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

export function countMap<K>(map: Map<K, number>, key: K) {
  let value: number;
  if (map.has(key)) {
    value = map.get(key)! + 1;
  } else {
    value = 1;
  }
  map.set(key, value);
}

export function printMap<K>(map: Map<K, number>, total: number) {
  const entries = Array.from(map.entries());

  entries.sort((a, b) => {
    return b[1] - a[1];
  });

  for (const [ key, count ] of entries) {
    const percent = (count * 100) / total;

    // Ignore outliers
    if (percent < 1) {
      continue;
    }

    console.log('  %s => %s %', key, percent.toFixed(2));
  }
}
