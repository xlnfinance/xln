import { expect, test } from 'bun:test';

import { buildHubReadySnapshotFence } from '../orchestrator/hub-ready-snapshot-fence';

const drained = (name: string, height: number) => ({
  name,
  online: true,
  height,
  quiescence: {
    pendingRuntimeWork: 0,
    pendingReliableOutputs: 0,
    pendingAccountFrames: 0,
    accountMempoolTxs: 0,
  },
});

test('ready snapshot fence requires every hub to report a drained runtime', () => {
  const ready = buildHubReadySnapshotFence([drained('H2', 20), drained('H1', 10)]);
  expect(ready.ready).toBe(true);
  expect(ready.signature).toBe(
    buildHubReadySnapshotFence([drained('H1', 10), drained('H2', 20)]).signature,
  );

  expect(buildHubReadySnapshotFence([
    drained('H1', 10),
    {
      ...drained('H2', 21),
      quiescence: {
        ...drained('H2', 21).quiescence,
        pendingRuntimeWork: 1,
      },
    },
  ]).ready).toBe(false);

  expect(buildHubReadySnapshotFence([{
    name: 'H1',
    online: true,
    height: 10,
    quiescence: {
      pendingReliableOutputs: 0,
      pendingAccountFrames: 0,
      accountMempoolTxs: 0,
    },
  }]).ready).toBe(false);
});
