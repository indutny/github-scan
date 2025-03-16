#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import * as fs from 'fs';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';
import { Buffer } from 'buffer';
import { promisify } from 'util';
import { Writable } from 'stream';
import { spawn } from 'child_process';

import {
  IPair, splitParse, keysFileName, getKeysFiles, getKeysFileChunk,
} from '../src/common';

const debug = debugAPI('github-scan');

const GITHUB_GRAPHQL = process.env.GITHUB_GRAPHQL ||
  'https://api.github.com/graphql';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const SPLIT_SIZE = 1 << 20;  // 1048576

const PAGE_SIZE = 100;
const PARALLEL = 1;

interface IGraphQLSSHKey {
  readonly key: string;
}

interface IGraphQLUser {
  readonly id: string;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly avatarUrl: string;
  readonly bio: string | null;
  readonly location: string | null;
  readonly websiteUrl: string | null;
  readonly publicKeys: { readonly nodes: ReadonlyArray<IGraphQLSSHKey> };

  readonly createdAt: string;
  readonly updatedAt: string;
}

interface IGraphQLResponse {
  readonly nodes: ReadonlyArray<IGraphQLUser | null>;
}

function buildQuery(ids: ReadonlyArray<number>) {
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

async function graphql(ids: ReadonlyArray<number>): Promise<IGraphQLResponse> {
  debug(`request users starting from ids "${ids}"`);

  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${GITHUB_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: buildQuery(ids),
      }),
    });
  } catch (e) {
    debug((e as Error).message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await graphql(ids);
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
      debug(`retrying ids="${ids}" in ${(timeout / 1000) | 0} secs`);

      // Add extra seconds to prevent immediate exhaustion
      await delay(timeout + 10000);

      return await graphql(ids);
    }
  }

  // Rate-limiting
  if (res.status === 403) {
    if (res.headers.has('retry-after')) {
      const secs = parseInt(res.headers.get('retry-after')!, 10);
      debug(`got retry-after header, retrying after ${secs}`);
      await delay(secs * 1000);
      return await graphql(ids);
    }

    if (!hasRateLimitInfo) {
      debug('403, but no rate limit information');
      debug(`status text ${res.statusText}`);
      debug('raw headers %j', res.headers.raw());
      debug('Retrying in 5 secs');
      await delay(5000);
      return await graphql(ids);
    }

    debug('403, but still have requests left');
    debug('Retrying in 5 secs');
    await delay(5000);
    return await graphql(ids);
  }

  if (res.status !== 200) {
    debug(`Unexpected error code: ${res.status}`);
    try {
      debug(`Body: ${await res.text()}`);
    } catch (e) {
    }
    debug('Retrying in 5 secs');
    await delay(5000);
    return await graphql(ids);
  }

  const link = res.headers.get('link');
  let next: boolean | string = false;
  if (link) {
    // Link: <...>; rel="next"
    const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      next = match[1];
    }
  }

  try {
    const json = await res.json();
    if (!json.data || !json.data.nodes || !Array.isArray(json.data.nodes)) {
      debug('Unexpected JSON response: %j', json);
      throw new Error('Invalid JSON');
    }
    return json.data;
  } catch (e) {
    debug((e as Error).message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await graphql(ids);
  }
}

function formatUser(user: IGraphQLUser): IPair | false {
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
  function fillRange(start: number, end: number) {
    const res: number[] = [];
    for (let i = start; i < end; i++) {
      res.push(i);
    }
    return res;
  }

  for (;;) {
    const ranges: ReadonlyArray<number>[] = [];
    for (let i = 0; i < parallel; i++) {
      const end = start + pageSize;
      ranges.push(fillRange(start, end));
      start = end;
    }

    const pages = await Promise.all(ranges.map(async (ids) => {
      return await graphql(ids);
    }));

    for (const page of pages) {
      for (const maybeUser of page.nodes) {
        if (!(maybeUser && maybeUser.hasOwnProperty('id'))) {
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
