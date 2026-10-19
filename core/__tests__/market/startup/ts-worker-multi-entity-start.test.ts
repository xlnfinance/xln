import { expect, test } from 'bun:test';
import { TsAccountWorkerCoordinator } from '../../../runtime/workers/account';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';

test('Account workers initialize all thirteen MM Entity owners while earlier owners remain live', async () => {
  const coordinators: TsAccountWorkerCoordinator[] = [];
  try {
    // The real MM bootstrap stalled on the thirteenth owner with eight workers
    // per owner. Keep the earlier owners alive, as the Runtime provider does.
    for (let index = 0; index < 13; index += 1) {
      const started = performance.now();
      console.log(`WORKER_OWNER_START index=${index}`);
      const ownerEntityId = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      const accounts = PersistentEntityAccountMap.empty(ownerEntityId, computeEntityAccountValueHash);
      const coordinator = await TsAccountWorkerCoordinator.create({
        ownerEntityId,
        workerCount: 8,
        accounts,
      });
      coordinators.push(coordinator);
      expect(coordinator.initialization.accounts).toBe(0);
      expect(coordinator.accountsRoot).toBe(accounts.rootHash());
      console.log(`WORKER_OWNER_READY index=${index} ms=${Math.round(performance.now() - started)}`);
    }
    expect(coordinators).toHaveLength(13);
  } finally {
    for (const coordinator of coordinators) coordinator.close();
  }
}, 50_000);
