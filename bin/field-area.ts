#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import { Hex } from 'hex-coords';

import { splitParse, IPair, getKeysFiles, parseSSHRSAKey } from '../src/common';

const debug = debugAPI('github-scan');

const BINS = 256;
const KEYS_DIR = process.argv[2];
const FIELD = process.argv[3] || 'key';

const MAX_KINDS = 10;

if (FIELD !== 'location' && FIELD !== 'key') {
  throw new Error('Unknown field');
}

interface IBin {
  total: number;
  readonly dates: number[];
}

async function main() {
  const files = await getKeysFiles(KEYS_DIR);

  const byKind: Map<string, IBin> = new Map();

  function track(kind: string, date: number) {
    let bin: IBin;
    if (byKind.has(kind)) {
      bin = byKind.get(kind)!;
    } else {
      bin = { total: 0, dates: [] };
      byKind.set(kind, bin);
    }
    bin.total++;
    bin.dates.push(date);
  }

  const extent = { min: Infinity, max: 0 };
  for (const file of files) {
    debug(`processing "${file}"`);
    const stream = fs.createReadStream(path.join(KEYS_DIR, file));
    for await (const pair of splitParse<IPair>(stream, (v) => JSON.parse(v))) {
      const date = new Date(FIELD === 'location' ? pair.user.createdAt :
        pair.user.updatedAt).getTime();

      extent.min = Math.min(extent.min, date);
      extent.max = Math.max(extent.max, date);

      if (FIELD === 'location') {
        if (!pair.user.location) {
          continue;
        }

        // Split off the state or country
        const location = pair.user.location.split(',', 1)[0];
        if (!location) {
          continue;
        }

        track(location.toLowerCase(), date);
        continue;
      }

      for (const key of pair.keys) {
        let kind: string;
        if (key.startsWith('ssh-ed25519')) {
          kind = 'ed25519';
        } else if (key.startsWith('ssh-dss')) {
          kind = 'dss';
        } else {
          const rsa = parseSSHRSAKey(key);
          if (!rsa) {
            continue;
          }
          kind = `rsa-` + rsa.length * 4;
        }

        track(kind, date);
      }
    }
  }

  const minDate = extent.min;
  const dateRange = extent.max - extent.min;

  // Sort keys by decreasing popularity
  const allKeyKinds: string[] = Array.from(byKind.entries())
    .sort(([ kind1, bin1 ], [ kind2, bin2 ]) => {
      return bin2.total - bin1.total;
    })
    .map(([ kind, _ ]) => kind);

  const keyKinds = allKeyKinds.slice(0, MAX_KINDS);

  debug('fitting into grid');
  const grid: Array<number[]> = new Array();
  for (let [ i, kind ] of keyKinds.entries()) {
    const bin = byKind.get(kind)!;

    const subGrid = new Array(BINS).fill(0);
    grid.push(subGrid);

    for (const date of bin.dates) {
      subGrid[Math.floor((date - minDate) * BINS / dateRange)]++;
    }
  }
  debug('key kinds=%j', keyKinds);

  debug('transposing');
  const transpose: Array<number[]> = new Array();
  for (let x = 0; x < BINS; x++) {
    transpose.push(grid.map((subGrid) => subGrid[x]));
  }

  const columns = transpose.map((stats, i): [ number, number[] ] => {
    return [ i * dateRange / BINS + minDate, stats ];
  }).filter((column) => {
    // Filter out empty columns
    return column[1].some((x) => x !== 0);
  });

  console.log(JSON.stringify({ legend: keyKinds, columns }));
}

main().catch((e) => {
  throw e;
})
