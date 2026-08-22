import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes } from 'ethers';
import { deserializeTaggedJson } from '../../../protocol/serialization';
import { importEntity } from '../../../runtime/registration/entity-creation';
import { acquireLocalTestPortLease } from '../../../scripts/e2e/harness/local-test-port-lease';
import {
  deriveLoadLaneIdentities,
  deriveLoadLaneSeeds,
} from '../../../scripts/operations/hlt/lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  spawnLaneRuntimes,
  stopLaneRuntimes,
} from '../../../scripts/operations/hlt/lanes/lane-runtimes';

const waitForEntity = async (lane: Awaited<ReturnType<typeof spawnLaneRuntimes>>[number]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await lane.runtime.control.listEntities()).some(entity => entity.entityId === lane.identity.entityId)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`SOVEREIGN_HOST_ENTITY_NOT_COMMITTED:${lane.identity.entityId}`);
};

test('one process hosts isolated sovereign Runtime replicas across worker shutdown', async () => {
  const lease = await acquireLocalTestPortLease({ timeoutMs: 10_000 });
  const workDir = mkdtempSync(join(tmpdir(), 'xln-sovereign-host-'));
  const rootSeed = 'sovereign-runtime-host-test-root';
  const seeds = deriveLoadLaneSeeds(rootSeed, 26, 'taker');
  const identities = deriveLoadLaneIdentities(rootSeed, 26, 'taker');
  const lanes = await spawnLaneRuntimes({
    workDir,
    portBase: lease.basePort,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: 0,
  });
  let stopped = false;
  try {
    expect(lanes).toHaveLength(26);
    expect(lanes[0]!.child).toBe(lanes[25]!.child);
    expect(lanes[0]!.hostIngress).toBe(lanes[1]!.hostIngress);
    expect(lanes[0]!.hostIngress).not.toBe(lanes[25]!.hostIngress);
    expect(lanes[0]!.port).not.toBe(lanes[1]!.port);
    expect(lanes[0]!.runtime.adapter.runtimeId).not.toBe(lanes[1]!.runtime.adapter.runtimeId);
    await queueLaneRuntimeInputWave(0, lanes.map(lane => ({
      lane,
      input: {
        runtimeTxs: [importEntity({
          entityId: lane.identity.entityId,
          signerId: lane.identity.signerId,
          entitySeed: getBytes(lane.identity.entitySeed),
          data: {
            config: lane.identity.consensusConfig,
            isProposer: true,
            profileName: lane.identity.name,
            position: lane.identity.position,
          },
        })],
        entityInputs: [],
      },
    })));
    await Promise.all(lanes.map(waitForEntity));
    const entitySets = await Promise.all(lanes.slice(0, 2).map(lane => lane.runtime.control.listEntities()));
    expect(entitySets[0]!.map(entity => entity.entityId)).toEqual([identities[0]!.entityId]);
    expect(entitySets[1]!.map(entity => entity.entityId)).toEqual([identities[1]!.entityId]);
    const diagnostics = await Promise.all([lanes[0]!, lanes[25]!].map(async lane => {
      const response = await fetch(`${lane.hostIngress.baseUrl}/api/hlt/diagnostics`, {
        headers: { authorization: `Bearer ${lane.hostIngress.authKey}` },
      });
      expect(response.ok).toBeTrue();
      return deserializeTaggedJson(await response.text()) as {
        runtimes: number;
        memory: { rss: number; heapUsed: number };
        totals: { radapterClients: number; relayClients: number; directClients: number };
      };
    }));
    expect(diagnostics.map(value => value.runtimes)).toEqual([25, 1]);
    expect(diagnostics.map(value => value.totals.radapterClients)).toEqual([25, 1]);
    expect(diagnostics.every(value => value.memory.rss > 0 && value.memory.heapUsed > 0)).toBeTrue();
    const child = lanes[0]!.child;
    await stopLaneRuntimes(lanes);
    stopped = true;
    const output = [...child.stdoutLines, ...child.stderrLines].join('\n');
    expect(output).not.toContain('HLT_SOVEREIGN_WORKER_STOP_ERROR');
    expect(output).not.toContain('HLT_SOVEREIGN_WORKER_CLOSE_UNAVAILABLE');
    expect(output).not.toContain('NAPI FATAL');
  } catch (error) {
    for (const lane of lanes) {
      console.error(`sovereign-host stdout:\n${lane.child.stdoutLines.slice(-80).join('\n')}`);
      console.error(`sovereign-host stderr:\n${lane.child.stderrLines.slice(-80).join('\n')}`);
    }
    throw error;
  } finally {
    if (!stopped) await stopLaneRuntimes(lanes);
    lease.release();
    rmSync(workDir, { recursive: true, force: true });
  }
}, 120_000);
