#!/usr/bin/env bun

import { parentPort } from 'node:worker_threads';
import { bytesToHex } from '../../src/core/primitives/encoding.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, shardRequestFingerprint } from '../../src/core/primitives/spec.ts';

parentPort?.on('message', ({ shardIndex, shardCount }) => {
  parentPort?.postMessage({
    specId: BRAINVAULT_V1_SPEC_ID,
    requestId: shardRequestFingerprint(
      shardIndex,
      shardCount,
      BRAINVAULT_V1.ALG_ID,
      BRAINVAULT_V1.SHARD_MEMORY_KB,
    ),
    shardIndex,
    result: bytesToHex(new Uint8Array(32).fill(shardIndex)),
  });
});
