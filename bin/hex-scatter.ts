#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import { Hex } from 'hex-coords';

import {
  getPairIterator, parseSSHRSAKey,
} from '../src/common';

const debug = debugAPI('github-scan');

const KEYS_DIR = process.argv[2];
const STEPS = 128;

interface IBinEntry {
  readonly center: [ number, number ];
  value: number;
}

async function main() {
  const points: number[] = [];

  let minDate = Infinity;
  let maxDate = 0;
  for await (const pair of getPairIterator(KEYS_DIR)) {
    const createdAt = new Date(pair.user.createdAt).getTime();
    const updatedAt = new Date(pair.user.updatedAt).getTime();

    maxDate = Math.max(maxDate, createdAt, updatedAt);
    minDate = Math.min(minDate, createdAt, updatedAt);

    points.push(createdAt, updatedAt);
  }

  debug('filling the table, points.len=%d', points.length);
  const radius = 1 / (Math.sqrt(3) * STEPS);
  const range = maxDate - minDate;

  const hex = new Hex(radius);
  const bins: Map<string, IBinEntry> = new Map();
  for (let i = 0; i < points.length; i += 2) {
    const createdAt = (points[i] - minDate) / range;
    const updatedAt = (points[i + 1] - minDate) / range;

    const p = hex.fromXY([ createdAt, updatedAt ]);
    const key = `${p[0]}:${p[1]}`;

    let entry: IBinEntry;
    if (bins.has(key)) {
      entry = bins.get(key)!;
    } else {
      entry = { value: 0, center: hex.toXY(p) };
      bins.set(key, entry);
    }
    entry.value++;
  }

  debug('stringifying, bins.size=%d', bins.size);
  console.log(JSON.stringify({
    offset: minDate,
    range: maxDate - minDate,
    radius,
    bins: Array.from(bins.values()),
  }));
}

main().catch((e) => {
  throw e;
})
