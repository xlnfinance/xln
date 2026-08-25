import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  createRuntimeHandle,
  runtimeAdapterConfigId,
  runtimeAdapterConfigsMatch,
} from '../../../frontend/packages/runtime-client/src/runtime-handle';

describe('runtime-client Runtime handle boundary', () => {
  test('projects the disconnected embedded handle without adapter state', () => {
    expect(createRuntimeHandle({ adapter: null, config: null, pendingRuntimeId: '' })).toEqual({
      id: 'embedded',
      runtimeId: 'embedded',
      pendingRuntimeId: '',
      mode: 'embedded',
      endpoint: 'embedded',
      permissions: 'write',
      status: 'disconnected',
      height: 0,
      authLevel: null,
      commandReady: false,
      commandReadyReason: 'adapter-disconnected',
    });
  });

  test('projects normalized remote identity, authority, height, and readiness', () => {
    const handle = createRuntimeHandle({
      config: {
        mode: 'remote',
        runtimeId: ' 0xABCD ',
        wsUrl: 'wss://runtime.example/rpc',
      },
      adapter: {
        runtimeId: ' 0xCDEF ',
        status: 'connected',
        currentHeight: 41.9,
        authLevel: 'admin',
        commandReady: true,
        commandReadyReason: null,
      },
      pendingRuntimeId: ' 0xABCD ',
    });

    expect(handle).toEqual({
      id: '0xcdef',
      runtimeId: '0xcdef',
      pendingRuntimeId: '0xabcd',
      mode: 'remote',
      endpoint: 'wss://runtime.example/rpc',
      permissions: 'write',
      status: 'connected',
      height: 41,
      authLevel: 'admin',
      commandReady: true,
      commandReadyReason: 'adapter-disconnected',
    });
  });

  test('keeps unauthenticated remote handles read-only and heights non-negative', () => {
    const handle = createRuntimeHandle({
      config: { mode: 'remote', wsUrl: 'ws://127.0.0.1:8080/runtime' },
      adapter: {
        runtimeId: '',
        status: 'connecting',
        currentHeight: -3,
        authLevel: 'inspect',
        commandReady: false,
        commandReadyReason: 'owner-binding-required',
      },
      pendingRuntimeId: '',
    });

    expect(handle.id).toBe('radapter:ws://127.0.0.1:8080/runtime');
    expect(handle.permissions).toBe('read');
    expect(handle.height).toBe(0);
    expect(handle.commandReadyReason).toBe('owner-binding-required');
  });

  test('matches configs by explicit Runtime identity before endpoint', () => {
    expect(runtimeAdapterConfigsMatch(
      { mode: 'remote', runtimeId: '0xAB', wsUrl: 'wss://one.example/runtime' },
      { mode: 'remote', runtimeId: '0xab', wsUrl: 'wss://two.example/runtime' },
    )).toBe(true);
    expect(runtimeAdapterConfigsMatch(
      { mode: 'remote', runtimeId: '0xAB' },
      { mode: 'remote', runtimeId: '0xCD' },
    )).toBe(false);
    expect(runtimeAdapterConfigsMatch(
      { mode: 'embedded', runtimeId: '0xAB' },
      { mode: 'remote', runtimeId: '0xAB' },
    )).toBe(false);
  });

  test('matches remote endpoints through the canonical WebSocket identity', () => {
    expect(runtimeAdapterConfigsMatch(
      { mode: 'remote', wsUrl: 'ws://localhost:8080/runtime/' },
      { mode: 'remote', wsUrl: 'ws://127.0.0.1:8080/runtime' },
    )).toBe(true);
    expect(runtimeAdapterConfigsMatch(
      { mode: 'remote', wsUrl: 'wss://runtime.example/one' },
      { mode: 'remote', wsUrl: 'wss://runtime.example/two' },
    )).toBe(false);
    expect(runtimeAdapterConfigsMatch(
      { mode: 'embedded' },
      { mode: 'embedded' },
    )).toBe(true);
  });

  test('uses stable fallback Runtime identities', () => {
    expect(runtimeAdapterConfigId({ mode: 'remote' })).toBe('radapter:remote');
    expect(runtimeAdapterConfigId({ mode: 'remote', wsUrl: 'WSS://Runtime.Example/RPC' }))
      .toBe('radapter:wss://runtime.example/rpc');
    expect(runtimeAdapterConfigId({ mode: 'embedded' })).toBe('embedded');
  });

  test('keeps Svelte lifecycle ownership on a thin projection adapter', () => {
    const boundary = readFileSync('frontend/packages/runtime-client/src/runtime-handle.ts', 'utf8');
    const controller = readFileSync('frontend/src/lib/stores/runtimeControllerStore.ts', 'utf8');
    const connection = readFileSync('frontend/src/lib/utils/runtime/runtimeConnection.ts', 'utf8');

    expect(controller).toContain('createRuntimeHandle');
    expect(controller).toContain('runtimeAdapterConfigsMatch');
    expect(controller).not.toContain('const configEndpoint =');
    expect(controller).not.toContain('const configId =');
    expect(controller).not.toContain('const adapterRuntimeId =');
    expect(controller).not.toContain("from '$lib/utils/runtime/wsUrl'");
    expect(boundary).not.toContain("from '../../../../core");
    expect(connection).toContain("from '../../../../packages/runtime-client/src/runtime-handle'");
    expect(connection).not.toContain("type { RuntimeHandle } from '$lib/stores/runtimeControllerStore'");
  });
});
