import * as debugAPI from 'debug';
import { workerData, parentPort } from 'worker_threads';
import { getKeysStreams, splitParse, Pair } from './common';

const debug = debugAPI('github-scan:common');

const {
  dir,
  index,
  workerCount,
  bufferSize,
} = workerData as {
  dir: string;
  index: number;
  workerCount: number;
  bufferSize: number;
};

async function main() {
  let buffer = new Array<Pair>();
  const files = await getKeysStreams(dir);
  for (const [i, createStream] of files.entries()) {
    if ((i % workerCount) !== index) {
      continue;
    }

    debug(`${index}/${workerCount} processing "${dir}:${i}"`);
    const stream = createStream();
    for await (const pair of splitParse(stream)) {
      buffer.push(pair);
      if (buffer.length >= bufferSize) {
        parentPort?.postMessage(buffer);
        buffer = [];
      }
    }
  }

  parentPort?.postMessage(buffer);
  buffer = [];

  // Done
  parentPort?.postMessage([]);
}
main();
