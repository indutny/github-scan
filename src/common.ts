import { Readable } from 'stream';

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
