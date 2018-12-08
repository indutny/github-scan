#!/usr/bin/env npx ts-node
import * as fs from 'fs';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';

const GITHUB_API = 'https://api.github.com';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

const KEYS_DIR = path.join(__dirname, 'keys');
const LAST_INDEX_FILE = path.join(KEYS_DIR, 'last-index.json');
const USER_FILE = path.join(KEYS_DIR, 'users.json');

interface IUser {
  readonly login: string;
  readonly id: number;
  readonly avatar_url: string;
  readonly gravatar_id: string;
  readonly email: string;
}

interface IKey {
  readonly id: number;
  readonly key: string;
}

type UserList = ReadonlyArray<IUser>;
type KeyList = ReadonlyArray<IKey>;

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function githubRequest<T>(path: string, query: string = ''): Promise<T> {
  let url = `${GITHUB_API}${path}`;
  if (GITHUB_CLIENT_ID) {
    url += `?client_id=${GITHUB_CLIENT_ID}`;
    url += `&client_secret=${GITHUB_CLIENT_SECRET}`;
    if (query) {
      url += `&${query}`;
    }
  } else if (query) {
    url += `?${query}`;
  }

  let res: Response;
  for (;;) {
    try {
      res = await fetch(url);
    } catch (e) {
      console.error(e.message);
      continue;
    }
    break;
  }

  // Rate-limiting
  if (res.status === 403) {
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining')!, 10);
    if (remaining > 0) {
      console.error(`403, but still have ${remaining} reqs left`);
      return await githubRequest(path);
    }

    const resetAt = parseInt(res.headers.get('x-ratelimit-reset')!, 10) * 1000;
    console.error(`rate limited until: ${new Date(resetAt)}`);

    const timeout = Math.max(0, resetAt - Date.now());
    console.error(`waiting ${(timeout / 1000) | 0} seconds`);

    // Add extra seconds to prevent immediate exhaustion
    await delay(timeout + 10000);

    return await githubRequest(path);
  }

  if (res.status !== 200) {
    throw new Error(`Unexpected error code: ${res.status}`);
  }

  return await res.json();
}

async function* githubUsers() {
  let lastId = 0;

  try {
    const rawIndex = await fs.promises.readFile(LAST_INDEX_FILE)
    lastId = parseInt(rawIndex.toString(), 10);
  } catch (e) {
    console.error('No index file, using 0');
  }

  for (;;) {
    const list = await githubRequest<UserList>('/users', `since=${lastId}`);
    lastId = list[list.length - 1].id;
    await fs.promises.writeFile(LAST_INDEX_FILE, lastId.toString());

    yield list;
  }
}

async function githubKeys(user: IUser) {
  return await githubRequest<KeyList>(`/users/${user.login}/keys`);
}

async function* fetchAll() {
  for await (const userPage of githubUsers()) {
    const pairs = await Promise.all(userPage.map(async (user) => {
      const keys = await githubKeys(user);

      return { user, keys };
    }));

    for (const pair of pairs) {
      yield pair;
    }
  }
}

async function main() {
  const out = fs.createWriteStream(USER_FILE, { flags: 'a+' });
  for await (const pair of fetchAll()) {
    const fileName = path.join(KEYS_DIR, pair.user.login + '.json');
    out.write('\n' + JSON.stringify(pair));
  }
}

main().catch((e) => {
  console.log(e);
});
