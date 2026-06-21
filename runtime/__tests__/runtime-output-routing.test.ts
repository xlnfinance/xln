import { describe, expect, test } from 'bun:test';
import { handleInboundP2PEntityInput, resolveRuntimeIdForEntity } from '../runtime-entity-routing';
import { dispatchEntityOutputs, planEntityOutputs } from '../runtime-output-routing';
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
          return true;
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(p2pCalls[0]?.input.entityId).toBe(output.entityId);
    expect(p2pCalls[0]?.ingressTimestamp).toBe(1234);
    expect(warnings).not.toContain('ROUTE_DIRECT_SOCKET_REQUIRED');
  });

  test('fails fast when P2P does not confirm delivery', () => {
    const targetRuntimeId = runtimeId('77');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('78'),
      signerId: runtimeId('79'),
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: entityId('80') },
      } as any],
    };
    const errors: Array<{ code: string; entityId?: string; runtimeId?: string; error?: string }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 9012,
      runtimeState: {
        directEntityInputDispatch: () => false,
      },
      warn: () => {},
      error: (_scope: string, code: string, payload: any) => {
        errors.push({ code, ...payload });
      },
    } as unknown as Env;

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInput: () => false,
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow(/ROUTE_SEND_NOT_DELIVERED/);

    expect(errors.some(entry => entry.code === 'ROUTE_SEND_FAILED')).toBe(true);
  });

  test('fails fast when neither direct dispatch nor P2P is available', () => {
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

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow(/ROUTE_NO_P2P/);
  });

  test('retargets trigger-only local outputs to the exact sole local signer before enqueue', () => {
    const localEntityId = entityId('66');
    const staleSignerId = runtimeId('67');
    const actualSignerId = runtimeId('68');
    const warnings: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: () => {},
      runtimeState: {},
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    });

    expect(result.localOutputs).toHaveLength(1);
    expect(result.localOutputs[0]?.signerId).toBe(actualSignerId);
    expect(result.deferredOutputs).toEqual([]);
    expect(warnings).toContain('ROUTE_RETARGET_LOCAL_TRIGGER_SIGNER');
  });

  test('retargets trigger-only remote outputs to the target gossip board signer before delivery', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const staleSenderSignerId = runtimeId('6b');
    const targetSignerId = runtimeId('6c');
    const warnings: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: () => {},
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: targetSignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(targetSignerId);
    expect(warnings).toContain('ROUTE_RETARGET_REMOTE_PROFILE_SIGNER');
  });

  test('fails fast on tx-bearing remote outputs with stale signer instead of gossip retargeting', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const staleSenderSignerId = runtimeId('6b');
    const targetSignerId = runtimeId('6c');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: targetSignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    expect(() => planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow('ROUTE_REMOTE_SIGNER_MISMATCH');

    expect(errors).toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('routes tx-bearing remote outputs when signer is a non-primary gossip board validator', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const primarySignerId = runtimeId('6b');
    const secondarySignerId = runtimeId('6c');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: primarySignerId }, { signerId: secondarySignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(errors).not.toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('routes consensus-only remote outputs without retargeting to primary gossip validator', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const primarySignerId = runtimeId('6b');
    const secondarySignerId = runtimeId('6c');
    const warnings: string[] = [];
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: primarySignerId }, { signerId: secondarySignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const proposedFrameResult = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      proposedFrame: {
        hash: '0xproposal',
        collectedSigs: new Map(),
      } as any,
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });
    const precommitResult = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      hashPrecommits: new Map([[primarySignerId, ['0xsig']]]),
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(proposedFrameResult.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(precommitResult.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(warnings).not.toContain('ROUTE_RETARGET_REMOTE_PROFILE_SIGNER');
    expect(errors).not.toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('resolves remote runtime directly from gossip profile when hint cache is empty', () => {
    const targetRuntimeId = runtimeId('6e');
    const targetEntityId = entityId('6f');
    const env = {
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          runtimeId: targetRuntimeId,
          metadata: { board: { validators: [{ signerId: runtimeId('70') }] } },
        }],
      },
    } as unknown as Env;

    const resolved = resolveRuntimeIdForEntity(env, targetEntityId, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
    });

    expect(resolved).toBe(targetRuntimeId);
  });

  test('fails fast on tx-bearing local outputs with stale signer instead of enqueueing a retry loop', () => {
    const localEntityId = entityId('69');
    const staleSignerId = runtimeId('6a');
    const actualSignerId = runtimeId('6b');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
    } as unknown as Env;

    expect(() => planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('6c'),
          tokenId: 1,
          amount: 1n,
          route: [localEntityId, entityId('6c')],
        },
      } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    })).toThrow(/ROUTE_LOCAL_SIGNER_MISMATCH/);
    expect(errors).toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('routes multi-signer outputs remotely when this runtime lacks the target signer', () => {
    const multiEntityId = entityId('74');
    const remoteSignerId = runtimeId('75');
    const targetRuntimeId = runtimeId('76');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: multiEntityId,
      signerId: remoteSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('77'),
          tokenId: 1,
          amount: 1n,
          route: [multiEntityId, entityId('77')],
        },
      } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.localOutputs).toEqual([]);
    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(remoteSignerId);
    expect(errors).not.toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('drops unavailable consensus-only signer without treating it as tx-bearing stale signer', () => {
    const localEntityId = entityId('78');
    const missingSignerId = runtimeId('79');
    const actualSignerId = runtimeId('7a');
    const warnings: string[] = [];
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: missingSignerId,
      proposedFrame: {
        hash: '0xproposal',
        collectedSigs: new Map(),
      } as any,
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    });

    expect(result.localOutputs).toEqual([]);
    expect(result.remoteOutputs).toEqual([]);
    expect(result.deferredOutputs).toEqual([]);
    expect(warnings).toContain('ROUTE_CONSENSUS_SIGNER_UNAVAILABLE');
    expect(errors).not.toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('fails fast on inbound tx-bearing P2P input with stale signer', () => {
    const localEntityId = entityId('70');
    const actualSignerId = runtimeId('71');
    const staleSignerId = runtimeId('72');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      eReplicas: new Map([[`${localEntityId}:${actualSignerId}`, { entityId: localEntityId, signerId: actualSignerId }]]),
      runtimeState: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('73'),
          tokenId: 1,
          amount: 1n,
          route: [localEntityId, entityId('73')],
        },
      } as any],
    }, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_targetEnv, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_SIGNER_MISMATCH/);
    expect(errors).toContain('INBOUND_ENTITY_SIGNER_MISMATCH');
    expect(enqueued).toHaveLength(0);
  });

  test('fails fast on inbound tx-bearing P2P input for an unknown local entity', () => {
    const targetEntityId = entityId('7b');
    const signerId = runtimeId('7c');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      eReplicas: new Map(),
      runtimeState: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: targetEntityId,
      signerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: entityId('7d'),
          tokenIds: [1],
        },
      } as any],
    }, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_UNKNOWN_TARGET/);
    expect(errors).toContain('INBOUND_ENTITY_UNKNOWN_TARGET');
    expect(enqueued).toHaveLength(0);
  });

  test('fails fast before enqueueing tx-bearing P2P input into a halted runtime', () => {
    const localEntityId = entityId('7e');
    const signerId = runtimeId('7f');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      runtimeState: { entityRuntimeHints: new Map(), halted: true },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: entityId('80'),
          toEntityId: localEntityId,
          height: 1,
        },
      } as any],
    }, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_RUNTIME_HALTED/);
    expect(errors).toContain('INBOUND_ENTITY_RUNTIME_HALTED');
    expect(enqueued).toHaveLength(0);
  });
});
