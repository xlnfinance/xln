import {
  writeDurableFile,
  type StorageDurabilityBoundary,
} from '../../../storage/fs-durability';
import { safeStringify } from '../../../protocol/serialization';

const markerPath = String(process.argv[2] || '');
const requestedBoundary = String(process.argv[3] || '') as StorageDurabilityBoundary;

if (!markerPath || !requestedBoundary) {
  throw new Error('marker path and durability boundary are required');
}

await writeDurableFile(
  markerPath,
  `${safeStringify({ snapshotHeight: 7, generation: 'durable-marker-v1' })}\n`,
  {
    onBoundary: (boundary) => {
      if (boundary !== requestedBoundary) return;
      process.kill(process.pid, 'SIGKILL');
    },
  },
);

throw new Error(`storage marker crash boundary was not reached: ${requestedBoundary}`);
