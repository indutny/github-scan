#!/usr/bin/env npx ts-node
import * as fs from 'fs';
import * as debugAPI from 'debug';
import * as ProgressBar from 'progress';

import { splitParse } from '../src/common';

const debug = debugAPI('github-scan');

const KEY_LIST = process.argv[2];

const TWO = BigInt(2);

type ProductTree = ReadonlyArray<ReadonlyArray<bigint>>;

interface ICheckMatch {
  readonly index: number;
  readonly divisor: bigint;
}

function productTree(values: ReadonlyArray<bigint>,
                     counter: () => void): ProductTree {
  if (values.length === 1) {
    return [ [ values[0] ] ];
  }

  if (values.length % 2 !== 0) {
    throw new Error('Invalid values');
  }

  const res: bigint[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const left = values[i];
    const right = values[i + 1];

    counter();
    res.push(left * right);
  }

  return productTree(res, counter).concat([ values ]);
}

function remainderTree(tree: ProductTree,
                       counter: () => void): ReadonlyArray<bigint> {
  let prev: bigint[] = tree[0].slice();

  for (let i = 1; i < tree.length; i++) {
    const curr = tree[i];

    const result: bigint[] = [];
    for (let j = 0; j < curr.length; j++) {
      result.push(prev[j >>> 1] % (curr[j] ** TWO));
      counter();
    }
    prev = result;
  }
  return prev;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function check(moduli: ReadonlyArray<bigint>) {
  debug(`running the check on ${moduli.length} moduli`);

  let totalOps = 0;

  // Product tree ops
  totalOps += moduli.length - 1;

  // Remainder tree ops
  totalOps += moduli.length - 1;

  // Quotient ops
  totalOps += moduli.length;

  // GCD ops
  totalOps += moduli.length;

  const bar = new ProgressBar('[:bar] :percent :elapsed/:eta sec', {
    total: totalOps,
    width: 80,
  });

  let finishedOps = 0;
  const counter = () => {
    finishedOps++;
    bar.tick();
  };

  // Algorithm by Bernstein:
  // https://cr.yp.to/factorization/smoothparts-20040510.pdf
  // See: https://factorable.net/weakkeys12.conference.pdf
  const products = productTree(moduli, counter);
  debug(`computed product tree of depth ${products.length}`);

  const remainders = remainderTree(products, counter);
  debug(`computed remainders`);

  const quotients: bigint[] = [];
  for (let i = 0; i < moduli.length; i++) {
    quotients.push(remainders[i] / moduli[i]);
    counter();
  }
  debug(`computed quotients`);

  const gcds: bigint[] = [];
  for (let i = 0; i < quotients.length; i++) {
    gcds.push(gcd(quotients[i], moduli[i]));
    counter();
  }
  debug(`computed gcds`);

  const matches: ICheckMatch[] = [];
  for (const [ i, gcd ] of gcds.entries()) {
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

  const matches = check(moduli);
  debug(`got ${matches.length} matches`);

  for (const match of matches) {
    process.stdout.write(`${match.index},${match.divisor.toString(16)}\n`);
  }
}

main().catch((e) => {
  throw e;
})
