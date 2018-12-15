import { ProductTree, productTree, remainderTree, gcd } from './common';

let moduli: ReadonlyArray<bigint> | undefined;
let tree: ProductTree | undefined;

process.on('message', (msg) => {
  if (msg.type === 'product-tree') {
    moduli = msg.moduli.map((v: string) => BigInt(v));

    tree = productTree(moduli!);

    process.send!({
      type: 'product-tree',
      top: `0x${tree[0][0].toString(16)}`,
    });
  } else if (msg.type === 'remainder-tree') {
    if (!tree) {
      throw new Error('Expected to compute product tree first!');
    }

    const head = BigInt(msg.head);

    const treeCopy: Array<ReadonlyArray<bigint>> = tree!.slice();
    treeCopy[0] = [ head ];

    const remainders = remainderTree(treeCopy);

    const quotients: bigint[] = [];
    for (let i = 0; i < moduli!.length; i++) {
      quotients.push(remainders[i] / moduli![i]);
    }

    const gcds: bigint[] = [];
    for (let i = 0; i < quotients.length; i++) {
      gcds.push(gcd(quotients[i], moduli![i]));
    }

    process.send!({
      type: 'remainder-tree',
      gcds: gcds.map((num) => `0x${num.toString(16)}`),
    });
  } else {
    throw new Error(`Unexpected message with type "${msg.type}"`);
  }
});
