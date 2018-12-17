#!/usr/bin/env npx ts-node
import { Buffer } from 'buffer';
import * as fs from 'fs';

import { splitParse, IPair } from '../src/common';

const INPUT_FILE = process.argv[2];
const OUTPUT_FILE = process.argv[3];

async function main() {
  const input = fs.createReadStream(INPUT_FILE);
  const out = fs.createWriteStream(OUTPUT_FILE);

  for await (const pair of splitParse<IPair>(input, (v) => JSON.parse(v))) {
    const { user, keys } = pair;

    const reduced = {
      user: {
        login: user.login,
        id: user.id,
        avatar_url: user.avatar_url,
        gravatar_id: user.gravatar_id,
        email: user.email,
      },
      keys,
    };
    out.write('\n' + JSON.stringify(reduced));
  }
  out.end();
}

main().catch((e) => {
  throw e;
})
