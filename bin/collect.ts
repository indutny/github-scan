#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import * as fs from 'fs';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';
import { Buffer } from 'buffer';
import { promisify } from 'util';
import { Writable } from 'stream';
import { spawn } from 'child_process';
import { z } from 'zod';

import {
  IPair, splitParse, keysFileName, getKeysFiles, getKeysFileChunk,
} from '../src/common';

const debug = debugAPI('github-scan');

const GITHUB_GRAPHQL = process.env.GITHUB_GRAPHQL ||
  'https://api.github.com/graphql';
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN ?? '').split(',');

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const SPLIT_SIZE = 1 << 20;  // 1048576

const PAGE_SIZE = 100;
const PARALLEL = 2 * GITHUB_TOKEN.length;

const optString = z.string().or(z.null());

const UserSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: optString,
  email: optString,
  company: optString,
  bio: optString,
  location: optString,
  websiteUrl: optString,
  createdAt: z.string(),
  updatedAt: z.string(),

  publicKeys: z.object({
    nodes: z.object({ key: z.string() }).array(),
  }),
});

const UserResponseSchema = z.object({
  data: z.object({
    nodes: UserSchema.or(z.null()).or(z.object({})).array(),
  }).optional(),
});

function buildUsersQuery(ids: ReadonlyArray<number>): string {
  const base64IDs = ids.map((id) => {
    return Buffer.from(`04:User${id}`).toString('base64');
  });

  return `query {
    nodes(ids: ${JSON.stringify(base64IDs)}) {
      ... on User {
        id
        login
        name
        email
        company
        bio
        location
        websiteUrl
        createdAt
        updatedAt

        publicKeys(first: 100) {
          nodes {
            key
          }
        }
      }
    }
  }`;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function graphql(logId: string, query: string): Promise<unknown> {
  debug(`grapql ${logId}`);

  const hash = createHash('sha256').update(query).digest()[0];
  const token = GITHUB_TOKEN[hash % GITHUB_TOKEN.length];

  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
      }),
    });
  } catch (e) {
    debug((e as Error).message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await graphql(logId, query);
  }

  const hasRateLimitInfo = res.headers.has('x-ratelimit-remaining') &&
    res.headers.has('x-ratelimit-reset');

  if (hasRateLimitInfo) {
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining')!, 10);
    debug(`remaining requests ${remaining}`);

    if (remaining <= 0) {
      const resetHeader = res.headers.get('x-ratelimit-reset')!;
      const resetAt = parseInt(resetHeader, 10) * 1000;
      debug(`rate limited until: ${new Date(resetAt)}`);

      const timeout = Math.max(0, resetAt - Date.now());
      debug(`retrying ${logId} in ${(timeout / 1000) | 0} secs`);

      // Add extra seconds to prevent immediate exhaustion
      await delay(timeout + 10000);

      return await graphql(logId, query);
    }
  }

  // Rate-limiting
  if (res.status === 403) {
    if (res.headers.has('retry-after')) {
      const secs = parseInt(res.headers.get('retry-after')!, 10);
      debug(`got retry-after header, retrying after ${secs}`);
      await delay(secs * 1000);
      return await graphql(logId, query);
    }

    if (!hasRateLimitInfo) {
      debug('403, but no rate limit information');
      debug(`status text ${res.statusText}`);
      debug('raw headers %j', res.headers.raw());
      debug('Retrying in 5 secs');
      await delay(5000);
      return await graphql(logId, query);
    }

    debug('403, but still have requests left');
    debug('Retrying in 5 secs');
    await delay(5000);
    return await graphql(logId, query);
  }

  if (res.status !== 200) {
    debug(`Unexpected error code: ${res.status}`);
    try {
      debug(`Body: ${await res.text()}`);
    } catch (e) {
    }
    debug('Retrying in 5 secs');
    await delay(5000);
    return await graphql(logId, query);
  }

  return await res.json();
}

async function getUsers(
  ids: ReadonlyArray<number>,
): Promise<z.infer<typeof UserResponseSchema>> {
  const logId = `users=${ids.at(0)}#${ids.length}`;
  const query = buildUsersQuery(ids);

  const json = await graphql(logId, query);

  try {
    return UserResponseSchema.parse(json);
  } catch (e) {
    debug((e as Error).message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await getUsers(ids);
  }
}

function formatUser(user: z.infer<typeof UserSchema>): IPair | false {
  const nodeId = Buffer.from(user.id, 'base64').toString();
  const match = nodeId.match(/^04:User(\d+)$/);
  if (!match) {
    return false;
  }

  const id = parseInt(match[1], 10);

  return {
    user: {
      id,
      login: user.login,
      name: user.name,
      email: user.email,
      company: user.company,
      bio: user.bio,
      location: user.location,
      websiteUrl: user.websiteUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    keys: user.publicKeys.nodes.map((key) => key.key),
  };
}

async function* fetchPairs(start: number,
                           pageSize: number = PAGE_SIZE,
                           parallel: number = PARALLEL)
    : AsyncIterableIterator<IPair> {
  let current = start;

  function nextRange() {
    const res: number[] = [];
    while (res.length < pageSize) {
      res.push(current);
      current += 1;
    }
    return res;
  }

  for (;;) {
    const ranges: ReadonlyArray<number>[] = [];
    for (let i = 0; i < parallel; i++) {
      ranges.push(nextRange());
    }

    const pages = await Promise.all(ranges.map(ids => getUsers(ids)));

    for (const page of pages) {
      if (!page.data) {
        debug('empty page');
        continue;
      }

      for (const maybeUser of page.data.nodes) {
        if (!(maybeUser && 'id' in maybeUser)) {
          continue;
        }

        const pair = formatUser(maybeUser);
        if (pair !== false) {
          yield pair;
        }
      }
    }
  }
}

async function getKeysFileStats(keysFile: string) {
  const file = fs.createReadStream(keysFile);
  let lastId = 0;
  let count = 0;
  for await (const pair of splitParse<IPair>(file, (v) => JSON.parse(v))) {
    lastId = Math.max(lastId, pair.user.id);
    count++;
  }
  file.close();
  return [ lastId, count ];
}

async function main() {
  const files = await getKeysFiles(KEYS_DIR);

  let keysFile: string;
  let chunkId: number;

  if (files.length === 0) {
    debug('no keys files, creating a new one');

    chunkId = 1;
    keysFile = path.join(KEYS_DIR, keysFileName(chunkId));
    await fs.promises.writeFile(keysFile, '');

  // Existing files - continue
  } else {
    const lastFile = files[files.length - 1]!;

    keysFile = path.join(KEYS_DIR, lastFile);
    chunkId = getKeysFileChunk(lastFile);
    debug(`found "${lastFile}" with chunkId ${chunkId}`);
  }

  let [ lastId, size ] = await getKeysFileStats(keysFile);
  const startId = lastId + 1;
  debug(`resuming from ${startId}, size ${size}`);

  let out: Writable | undefined;
  for await (const pair of fetchPairs(startId)) {
    if (size >= SPLIT_SIZE) {
      debug('keys file is full, creating new chunk');
      chunkId++;

      const oldFile = keysFile;
      keysFile = path.join(KEYS_DIR, keysFileName(chunkId));

      if (out) {
        debug('ending previous stream');
        out.end();
      }

      spawn('xz', ['--compress', '-9', oldFile], {
        cwd: KEYS_DIR,
      });

      out = undefined;

      size = 0;
    }

    if (!out) {
      debug(`opening write stream for "${keysFile}"`);
      out = fs.createWriteStream(keysFile, { flags: 'a+' });
    }

    debug(`got user with login "${pair.user.login}"`);
    out!.write(`\n${JSON.stringify(pair)}`);
    size++;
  }

  debug('end');
  if (out) {
    out.end();
  }
}

main().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});
