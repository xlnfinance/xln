import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { encodeBuffer } from '../../../core/storage/codec/codec';
import { executeCrossJOpeningLifecycleVector } from './lifecycle';

const target = join(import.meta.dir, 'lifecycle-v1.json');
const fixture = await executeCrossJOpeningLifecycleVector();
await writeFile(target, `${safeStringify(fixture, 2)}\n`, 'utf8');
process.stdout.write(`${target}\n`);

// Rebuild the captured incomplete-cohort shape with current signed proposals;
// never patch fields into obsolete signed frames. Only the retry's Runtime
// coordinate advances; its Account proposal and witnesses stay byte-identical.
const opening = fixture.frames[0];
const original = opening?.outbox.walOutputs[0];
if (!opening || opening.outbox.walOutputs.length !== 2 || !original?.sourceRuntimeFrame) {
  throw new Error('CROSS_J_RETRY_OPENING_PAIR_MISSING');
}
const source = original.sourceRuntimeFrame;
const retrySource = { height: source.height + 1, timestamp: source.timestamp + 1 };
const retryTarget = join(import.meta.dir, '../../../core/__tests__/fixtures/storage/cross-j-proposal-retry.json');
await writeFile(retryTarget, `${safeStringify({
  source: 'Current TypeScript cross-J opening; reconstructs the captured epoch-rotation incomplete retry cohort',
  runtimeId: fixture.setup.hubRuntimeId,
  rows: [
    { ...source, rowsBase64: opening.outbox.walOutputs.map(row => encodeBuffer(row).toString('base64')) },
    { ...retrySource, rowsBase64: [encodeBuffer({ ...original, sourceRuntimeFrame: retrySource }).toString('base64')] },
  ],
}, 2)}\n`, 'utf8');
process.stdout.write(`${retryTarget}\n`);
