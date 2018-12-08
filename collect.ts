#!/usr/bin/env npx ts-node
import * as fs from 'fs';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';

const GITHUB_API = 'https://api.github.com';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

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
    const resetAt = parseInt(res.headers.get('x-ratelimit-reset')!, 10) * 1000;
    console.error(`rate limited until: ${new Date(resetAt)}`);

    await delay(Math.max(0, resetAt - Date.now()));

    return await githubRequest(path);
  }

  if (res.status !== 200) {
    throw new Error(`Unexpected error code: ${res.status}`);
  }

  return await res.json();
}

async function* githubUsers() {
  let lastId = 0;

  for (;;) {
    const list = await githubRequest<UserList>('/users', `since=${lastId}`);
    lastId = list[list.length - 1].id;

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
  for await (const pair of fetchAll()) {
    fs.writeFileSync(path.join(__dirname, 'keys', pair.user.login + '.json'),
      JSON.stringify(pair));
  }
}

main().catch((e) => {
  console.log(e);
});
