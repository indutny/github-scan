#!/usr/bin/env npx ts-node
import * as fs from 'fs';
import * as path from 'path';
import * as debugAPI from 'debug';
import * as os from 'os';
import { fork, ChildProcess } from 'child_process';

import { splitParse, productTree, remainderTree } from '../src/common';

const debug = debugAPI('github-scan');

const KEY_LIST = process.argv[2];

const WORKER_PATH = path.join(__dirname, '..', 'src', 'worker');
const CPU_COUNT = os.cpus().length;

interface ICheckMatch {
  readonly index: number;
  readonly divisor: bigint;
}

// Algorithm by Bernstein:
// https://cr.yp.to/factorization/smoothparts-20040510.pdf
// See: https://factorable.net/weakkeys12.conference.pdf
async function check(moduli: ReadonlyArray<bigint>) {
  debug(`running the check on ${moduli.length} moduli`);

  if (moduli.length % CPU_COUNT !== 0) {
    throw new Error('Need power of two processors');
  }

  debug(`spawning ${CPU_COUNT} workers`);
  const workers: ChildProcess[] = [];
  for (let i = 0; i < CPU_COUNT; i++) {
    workers.push(fork(WORKER_PATH));
  }

  debug('distributing moduli to each worker and computing product tree');
  const splitSize = moduli.length / workers.length;

  let promises: Promise<bigint>[] = [];
  for (const [ i, worker ] of workers.entries()) {
    promises.push(new Promise((resolve, reject) => {
      worker.once('message', (msg) => {
        if (msg.type !== 'product-tree') {
          reject(new Error(`Unexpected message "${msg.type}"`));
          return;
        }

        debug(`got product tree top from worker ${i} len=${msg.top.length}`);
        resolve(BigInt(msg.top));
      });
    }));

    worker.send({
      type: 'product-tree',
      moduli: moduli.slice(i * splitSize, (i + 1) * splitSize).map((mod) => {
        return `0x${mod.toString(16)}`;
      }),
    });
  }

  debug('waiting for partial product tree completion');

  const treeTops = await Promise.all(promises);

  debug('computing head of the product tree');
  const productHead = productTree(treeTops);

  debug('computing remainders of head of the product tree');
  const remainders = remainderTree(productHead);
  if (remainders.length !== workers.length) {
    throw new Error('Unexpected remainders length');
  }

  debug('distributing tree head to each worker and computing remainder tree');
  promises = [];
  for (const [ i, worker ] of workers.entries()) {
    promises.push(new Promise((resolve, reject) => {
      worker.once('message', (msg) => {
        if (msg.type !== 'remainder-tree') {
          reject(new Error(`Unexpected message "${msg.type}"`));
          return;
        }

        debug(`got gcd from worker ${i}`);
        resolve(msg.gcds.map((num: string) => BigInt(num)));
      });
    }));

    worker.send({
      type: 'remainder-tree',
      head: `0x${remainders[i].toString(16)}`,
    });
  }

  debug('waiting for all gcds');
  const gcds = await Promise.all(promises);

  for (const worker of workers) {
    worker.kill();
  }

  const matches: ICheckMatch[] = [];
  for (const [ i, gcd ] of gcds.flat().entries()) {
    if (gcd !== 1n) {
      matches.push({ index: i, divisor: gcd });
    }
  }

  return matches;
}

function parseModulo(value: string): bigint {
  return BigInt(`0x${value}`);
}

async function main() {
  const stream = fs.createReadStream(KEY_LIST);

  const moduli: bigint[] = [];
  for await (const value of splitParse(stream, parseModulo)) {
    moduli.push(value);
  }

  debug(`read ${moduli.length} moduli from "${KEY_LIST}"`);

  // Pad moduli for constructing binary tree
  let padSize = 1;
  while (padSize < moduli.length) {
    padSize <<= 1;
  }
  padSize -= moduli.length;

  // TODO(indutny): spread out padding to improve speed
  debug(`padding with ${padSize} ones`);
  const padValue = BigInt(1);
  for (let i = 0; i < padSize; i++) {
    moduli.push(padValue);
  }

  const matches = await check(moduli);
  debug(`got ${matches.length} matches`);

  for (const match of matches) {
    process.stdout.write(`${match.index},${match.divisor.toString(16)}\n`);
  }
}

main().catch((e) => {
  throw e;
})
