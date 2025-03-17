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
    remained: 0,

    name: {
      changed: 0,
      added: 0,
      removed: 0,
    },
    company: {
      changed: 0,
      added: 0,
      removed: 0,
    },
    bio: {
      changed: 0,
      added: 0,
      removed: 0,
    },
    location: {
      changed: 0,
      added: 0,
      removed: 0,
    },
    websiteUrl: {
      changed: 0,
      added: 0,
      removed: 0,
    },
    updated: 0,
    sshKeyChanged: 0,
    sshKeys: {
      changed: 0,
      addedED25519: 0,
      addedRSA: 0,
    },
  };

  let bioDiffSum = 0;
  let bioDiffCount = 0;

  const KEYS = [
    'name' as const,
    'company' as const,
    'bio' as const,
    'location' as const,
    'websiteUrl' as const,
  ];

  function compare(oldPair: Pair, newPair: Pair): void {
    stats.remained++;

    const oldUser = oldPair.user;
    const oldKeys = oldPair.keys;
    const newUser = newPair.user;
    const newKeys = newPair.keys;

    if (oldUser.updatedAt !== newUser.updatedAt) {
      stats.updated++;
    }

    for (const key of KEYS) {
      const before = oldUser[key];
      const after = newUser[key];
      if (before === after || !before && !after) {
        continue;
      }
      if (!before) {
        stats[key].added++;
      } else if (!after) {
        stats[key].removed++;
      } else {
        stats[key].changed++;
      }
    }
    if (oldUser.bio !== newUser.bio) {
      bioDiffSum += (newUser.bio || '').length - (oldUser.bio || '').length;
      bioDiffCount++;
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

    stats.sshKeys.changed++;
    const oldTypes = new Set(oldKeys.map(key => key.split(' ', 1)[0]));
    const newTypes = new Set(newKeys.map(key => key.split(' ', 1)[0]));

    if (!oldTypes.has('ssh-ed25519') && newTypes.has('ssh-ed25519')) {
      stats.sshKeys.addedED25519++;
    }
    if (!oldTypes.has('ssh-rsa') && newTypes.has('ssh-rsa')) {
      stats.sshKeys.addedRSA++;
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
    } else if (oldPair.user.id < newPair.user.id) {
      onLeave(oldPair);
      oldEntry = await oldIter.next();
    } else {
      onJoin(newPair);
      newEntry = await newIter.next();
    }
  }

  // TODO: move to the end
  console.log(stats);
  console.log(`Average bio length diff: ${bioDiffSum / bioDiffCount}`);

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
