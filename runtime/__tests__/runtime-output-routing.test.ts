import { describe, expect, test } from 'bun:test';
import { dispatchEntityOutputs } from '../runtime-output-routing';
import type { DeliverableEntityInput, Env, RoutedEntityInput } from '../types';

const runtimeId = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

describe('runtime output routing', () => {
  test('falls back to encrypted P2P delivery after direct dispatch misses', () => {
    const targetRuntimeId = runtimeId('22');
    const warnings: string[] = [];
    const p2pCalls: Array<{ targetRuntimeId: string; input: DeliverableEntityInput; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 1234,
      runtimeState: {
        directEntityInputDispatch: () => false,
      },
      warn: (_scope: string, code: string) => {
        warnings.push(code);
      },
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('33'),
      signerId: runtimeId('34'),
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: { orderId: 'route-1' } },
      } as any],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInput: (runtimeId, input, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, input, ingressTimestamp });
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(p2pCalls[0]?.input.entityId).toBe(output.entityId);
    expect(p2pCalls[0]?.ingressTimestamp).toBe(1234);
    expect(warnings).not.toContain('ROUTE_DEFER_DIRECT_SOCKET_REQUIRED');
  });

  test('defers when neither direct dispatch nor P2P is available', () => {
    const targetRuntimeId = runtimeId('44');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('55'),
      signerId: runtimeId('56'),
      entityTxs: [],
    };
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 5678,
      runtimeState: {
        directEntityInputDispatch: () => false,
      },
      warn: () => {},
    } as unknown as Env;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect((deferred as RoutedEntityInput[]).map(input => input.entityId)).toEqual([output.entityId]);
  });
});
