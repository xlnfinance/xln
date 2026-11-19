# HyperSync Node.js 1.4.1 returns the transactions root as the block mix hash

## Summary

On Arbitrum Sepolia (chain ID 421614), the official Node.js client's
`getWithRateLimit()` returns the block's transaction trie root in
`block.mixHash`. The HyperSync JSON endpoint and Envio's raw Arrow API
return the same canonical `mix_hash`. Reconstructing the block hash with
the Node.js result fails.

## Reproduce

Install `@envio-dev/hypersync-client@1.4.1` in a scratch directory and
run this script on Apple Silicon with Bun. Supply a HyperSync API token
through `ENVIO_API_TOKEN`.

```ts
import { HypersyncClient, JoinMode } from '@envio-dev/hypersync-client';

const url = 'https://arbitrum-sepolia.hypersync.xyz';
const apiToken = process.env.ENVIO_API_TOKEN;
if (!apiToken) throw new Error('ENVIO_API_TOKEN is required');

const fromBlock = 329897179;
const toBlock = fromBlock + 1;
const client = new HypersyncClient({ url, apiToken, maxNumRetries: 0 });
const { response } = await client.getWithRateLimit({
  fromBlock,
  toBlock,
  includeAllBlocks: true,
  joinMode: JoinMode.JoinNothing,
  fieldSelection: { block: ['Number', 'Hash', 'MixHash', 'TransactionsRoot'] },
});
const node = response?.data.blocks[0];
if (node?.number !== fromBlock) throw new Error('Expected the requested block');

const jsonResponse = await fetch(`${url}/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    from_block: fromBlock,
    to_block: toBlock,
    include_all_blocks: true,
    join_mode: 'JoinNothing',
    field_selection: { block: ['number', 'hash', 'mix_hash', 'transactions_root'] },
  }),
});
if (!jsonResponse.ok) throw new Error(`HyperSync JSON HTTP ${jsonResponse.status}`);
const json = (await jsonResponse.json()).data.flatMap(group => group.blocks ?? [])[0];
if (json?.hash !== node.hash) throw new Error('Expected the same block hash');
console.log({
  block: node.number,
  hash: node.hash,
  nodeMixHash: node.mixHash,
  jsonMixHash: json.mix_hash,
  transactionRoot: json.transactions_root,
});
```

## Observed result

| Field | Block 329897179 |
| --- | --- |
| Block hash | `0x66da8d0eb16fc536851428ee94da6058eb272e415394babe003345dc29590c8a` |
| Expected `mixHash`, JSON and raw Arrow | `0x000000000001d0a20000000000b9650a000000000000003d0001000000000000` |
| Actual Node.js `mixHash` | `0x89a5ac6a22b8e3e3a1f7015da6ee49a6e2433cc06bb9d59c19e1b35bd025eb41` |
| `transactionsRoot` | `0x89a5ac6a22b8e3e3a1f7015da6ee49a6e2433cc06bb9d59c19e1b35bd025eb41` |

The result reproduced on blocks 329897179 through 329897186. All eight
JSON and raw Arrow headers reconstructed their claimed hashes. The Node.js
result differed only in `mixHash` on each of the eight headers, which
caused all eight hash checks to fail.
[XLN verification and timings](evm-log-indexes-for-j-watcher.md#comparing-hypersync-json-and-arrow)

## Likely fix

In `Block::from_simple`, map `mix_hash` from `b.mix_hash`. Add a
regression fixture whose transaction trie root and mix hash differ.
[Envio Node.js block mapping](https://github.com/enviodev/hypersync-client-node/blob/main/src/types.rs)
