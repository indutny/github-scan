#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { getPairIterator, type Pair } from '../src/common';

const debug = debugAPI('github-scan');

const OLD_KEYS_DIR = process.argv[2];
const NEW_KEYS_DIR = process.argv[3];

async function main() {
  const stats = {
    joined: 0,
    left: 0,
    changes: {
      name: 0,
      company: 0,
      bio: 0,
      location: 0,
      website: 0,
      keys: 0,

      total: 0,
    },
    migrations: {
      ecc: 0,
      rsa: 0,
    },
  };

  let bioDiffSum = 0;

  function compare(oldPair: Pair, newPair: Pair): void {
    const oldUser = oldPair.user;
    const oldKeys = oldPair.keys;
    const newUser = newPair.user;
    const newKeys = newPair.keys;

    if (oldUser.updatedAt !== newUser.updatedAt) {
      stats.changes.total++;
    }
    if (oldUser.name !== newUser.name) {
      stats.changes.name++;
    }
    if (oldUser.company !== newUser.company) {
      stats.changes.company++;
    }
    if (oldUser.bio !== newUser.bio) {
      stats.changes.bio++;
      bioDiffSum += (newUser.bio || '').length - (oldUser.bio || '').length;
    }
    if (oldUser.location !== newUser.location) {
      stats.changes.location++;
    }
    if (oldUser.websiteUrl !== newUser.websiteUrl) {
      stats.changes.website++;
    }

    let keysChanged = false;
    if (oldKeys.length === newKeys.length) {
      for (let i = 0; i < oldKeys.length; i++) {
        if (oldKeys[i] !== newKeys[i]) {
          keysChanged = true;
          break;
        }
      }
    } else {
      keysChanged = true;
    }

    if (!keysChanged) {
      return;
    }

    stats.changes.keys++;
    const oldTypes = new Set(oldKeys.map(key => key.split(' ', 1)[0]));
    const newTypes = new Set(newKeys.map(key => key.split(' ', 1)[0]));

    if (!oldTypes.has('ssh-ed25519') && newTypes.has('ssh-ed25519')) {
      stats.migrations.ecc++;
    }
    if (!oldTypes.has('ssh-rsa') && newTypes.has('ssh-rsa')) {
      stats.migrations.rsa++;
    }
  }

  function onLeave(pair: Pair): void {
    stats.left++;
  }

  function onJoin(pair: Pair): void {
    stats.joined++;
  }

  const oldIter = getPairIterator(OLD_KEYS_DIR);
  const newIter = getPairIterator(NEW_KEYS_DIR);

  let oldEntry = await oldIter.next();
  let newEntry = await newIter.next();
  while (!oldEntry.done && !newEntry.done) {
    const oldPair = oldEntry.value;
    const newPair = newEntry.value;

    if (oldPair.user.id === newPair.user.id) {
      compare(oldPair, newPair);
      oldEntry = await oldIter.next();
      newEntry = await newIter.next();
    } if (oldPair.user.id < newPair.user.id) {
      onLeave(oldPair);
      oldEntry = await oldIter.next();
    } else {
      onJoin(newPair);
      newEntry = await newIter.next();
    }
  }

  // TODO: move to the end
  console.log(stats);

  while (!oldEntry.done) {
    onLeave(oldEntry.value);
    oldEntry = await oldIter.next();
  }

  while (!newEntry.done) {
    onJoin(newEntry.value);
    newEntry = await newIter.next();
  }
}

main().catch((e) => {
  throw e;
})
