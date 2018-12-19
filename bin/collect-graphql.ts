#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import * as fs from 'fs';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';
import { Buffer } from 'buffer';
import { promisify } from 'util';

import { splitParse } from '../src/common';

const debug = debugAPI('github-scan');

const GITHUB_GRAPHQL = process.env.GITHUB_GRAPHQL ||
  'https://api.github.com/graphql';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const KEYS_FILE = path.join(KEYS_DIR, 'keys.json');

const PAGE_SIZE = 100;
const PARALLEL = 1;

interface IPair {
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
        avatarUrl(size: 256)
        bio
        location
        websiteUrl
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
    debug(e.message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await graphql(ids);
  }

  // Rate-limiting
  if (res.status === 403) {
    if (res.headers.has('retry-after')) {
      const secs = parseInt(res.headers.get('retry-after'), 10);
      debug(`got retry-after header, retrying after ${secs}`);
      await delay(secs * 1000);
      return await graphql(ids);
    }

    if (!res.headers.has('x-ratelimit-remaining')) {
      debug('403, but no rate limit information');
      debug(`status text ${res.statusText}`);
      debug('raw headers %j', res.headers.raw());
      debug('Retrying in 5 secs');
      await delay(5000);
      return await graphql(ids);
    }

    const remaining = parseInt(res.headers.get('x-ratelimit-remaining')!, 10);
    if (remaining > 0) {
      debug(`403, but still have ${remaining} reqs left`);
      debug('Retrying in 5 secs');
      await delay(5000);
      return await graphql(ids);
    }

    const resetAt = parseInt(res.headers.get('x-ratelimit-reset')!, 10) * 1000;
    debug(`rate limited until: ${new Date(resetAt)}`);

    const timeout = Math.max(0, resetAt - Date.now());
    debug(`retrying ids="${ids}" in ${(timeout / 1000) | 0} secs`);

    // Add extra seconds to prevent immediate exhaustion
    await delay(timeout + 10000);

    return await graphql(ids);
  }

  if (res.status !== 200) {
    debug(`Unexpected error code: ${res.status}`);
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
    return json.data;
  } catch (e) {
    debug(e.message);
    debug(`retrying request in 5 secs`);
    await delay(5000);
    return await graphql(ids);
  }
}

async function getLastId() {
  if (!await promisify(fs.exists)(KEYS_FILE)) {
    return 0;
  }

  const input = fs.createReadStream(KEYS_FILE);
  let lastId = 0;
  for await (const pair of splitParse<IPair>(input, (v) => JSON.parse(v))) {
    lastId = Math.max(lastId, pair.user.id);
  }
  input.close();
  return lastId;
}

async function* fetchUsers(start: number,
                           pageSize: number = PAGE_SIZE,
                           parallel: number = PARALLEL)
    : AsyncIterableIterator<IGraphQLUser> {
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
        if (maybeUser && maybeUser.hasOwnProperty('id')) {
          yield maybeUser;
        }
      }
    }
  }
}

async function main() {
  const startId = (await getLastId()) + 1;
  debug(`starting from ${startId}`);

  const out = fs.createWriteStream(KEYS_FILE, { flags: 'a+' });
  for await (const user of fetchUsers(startId)) {
    if (!user || !user.hasOwnProperty('id')) {
      continue;
    }
    debug(`got user with login "${user.login}"`);

    const nodeId = Buffer.from(user.id, 'base64').toString();
    const match = nodeId.match(/^04:User(\d+)$/);
    if (!match) {
      continue;
    }

    const id = parseInt(match[1], 10);

    const format = {
      user: {
        id,
        login: user.login,
        name: user.name,
        email: user.email,
        company: user.company,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        location: user.location,
        websiteUrl: user.websiteUrl,
      },
      keys: user.publicKeys.nodes.map((key) => key.key),
    };
    out.write(`\n${JSON.stringify(format)}`);
  }
}

main().catch((e) => {
  console.log(e);
});
