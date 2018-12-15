import { Readable } from 'stream';

const TWO = BigInt(2);

export interface IKey {
  readonly id: number;
  readonly key: string;
}

export interface IUser {
  readonly login: string;
  readonly id: number;
  readonly avatar_url: string;
  readonly gravatar_id: string;
  readonly email: string;
}

export type UserList = ReadonlyArray<IUser>;
export type KeyList = ReadonlyArray<IKey>;

export interface IPair {
  readonly user: IUser;
  readonly keys: KeyList;
}

export type ProductTree = ReadonlyArray<ReadonlyArray<bigint>>;

export async function* splitParse<T>(stream: Readable,
                                     parse: (v: string) => T) {
  let buffer: string = '';
  for await (const data of stream) {
    let start: number = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xa) {
        buffer += data.slice(start, i);
        start = i + 1;
        if (buffer) {
          yield parse(buffer);
        }

        buffer = '';
      }
    }

    if (start < data.length) {
      buffer += data.slice(start);
    }
  }

  if (buffer) {
    yield parse(buffer);
  }
}

export function productTree(values: ReadonlyArray<bigint>): ProductTree {
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

    res.push(left * right);
  }

  return productTree(res).concat([ values ]);
}

export function remainderTree(tree: ProductTree): ReadonlyArray<bigint> {
  let prev: bigint[] = tree[0].slice();

  for (let i = 1; i < tree.length; i++) {
    const curr = tree[i];

    const result: bigint[] = [];
    for (let j = 0; j < curr.length; j++) {
      result.push(prev[j >>> 1] % (curr[j] ** TWO));
    }
    prev = result;
  }
  return prev;
}

export function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
