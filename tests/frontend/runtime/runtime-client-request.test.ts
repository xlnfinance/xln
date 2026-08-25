import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  decodeRemoteRuntimeRequest,
  hasRemoteRuntimeQueryBootstrap,
  remoteAccessFromAuthKey,
  remoteRuntimeRequestRequiresConsent,
  removeRemoteRuntimeImportParams,
  runtimeImportPayloadFromHash,
  runtimeImportSourceFromHash,
} from '../../../frontend/packages/runtime-client/src/remote-runtime-request';
import {
  normalizeWsConnectUrl,
  normalizeWsUrl,
  runtimeHttpOriginFromWsUrl,
  sameWsEndpoint,
} from '../../../frontend/packages/runtime-client/src/ws-url';

const ADMIN_TOKEN = 'xlnra1.admin.payload.signature.checksum.tail';

describe('runtime-client remote request boundary', () => {
  test('normalizes display, connection, comparison, and HTTP Runtime URLs', () => {
    expect(normalizeWsUrl('ws://127.0.0.2:8080/rpc/?ignored=1#hash'))
      .toBe('ws://localhost:8080/rpc');
    expect(normalizeWsConnectUrl('ws://localhost:8080/rpc/?ignored=1#hash'))
      .toBe('ws://127.0.0.1:8080/rpc');
    expect(sameWsEndpoint('wss://runtime.example/rpc/', 'wss://runtime.example:443/rpc'))
      .toBe(true);
    expect(runtimeHttpOriginFromWsUrl('wss://runtime.example/rpc'))
      .toBe('https://runtime.example');
  });

  test('decodes an authenticated remote Runtime hash without browser globals', () => {
    const request = decodeRemoteRuntimeRequest({
      search: '',
      hash: `#runtime=remote&ws=${encodeURIComponent('wss://runtime.example/rpc')}&token=${ADMIN_TOKEN}`,
    }, {
      resolveStoredAuthKey: () => {
        throw new Error('STORED_AUTH_SHOULD_NOT_BE_READ');
      },
    });

    expect(request).toEqual({
      wsUrl: 'wss://runtime.example/rpc',
      authKey: ADMIN_TOKEN,
      hostLabel: 'wss://runtime.example/rpc',
      keyLabel: 'full capability',
      acceptKey: 'xln-remote-runtime-accepted:wss://runtime.example/rpc|xlnra1.admin.pay|re.checksum.tail',
      requiresAuthPaste: false,
    });
  });

  test('uses tab-confined stored authority or requires an explicit paste', () => {
    const location = {
      search: '',
      hash: '#adapter=remote&runtimeWs=ws%3A%2F%2Flocalhost%3A8080%2Frpc',
    };
    const stored = decodeRemoteRuntimeRequest(location, {
      resolveStoredAuthKey: () => ADMIN_TOKEN,
    });
    const missing = decodeRemoteRuntimeRequest(location, {
      resolveStoredAuthKey: () => '',
    });

    expect(stored).toMatchObject({
      wsUrl: 'ws://127.0.0.1:8080/rpc',
      authKey: ADMIN_TOKEN,
      requiresAuthPaste: false,
    });
    expect(missing).toMatchObject({
      authKey: '',
      keyLabel: 'capability must be pasted',
      requiresAuthPaste: true,
    });
  });

  test('rejects secret-bearing query bootstrap before resolving authority', () => {
    let resolverCalls = 0;
    const search = '?runtime-import=secret';
    expect(hasRemoteRuntimeQueryBootstrap(search)).toBe(true);
    expect(() => decodeRemoteRuntimeRequest({ search, hash: '' }, {
      resolveStoredAuthKey: () => {
        resolverCalls += 1;
        return ADMIN_TOKEN;
      },
    })).toThrow('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
    expect(resolverCalls).toBe(0);
  });

  test('extracts imports from hash and strips only import parameters', () => {
    const hash = '#runtime-import=payload&runtime-import-src=%2Fapi%2Fruntime-import';
    expect(runtimeImportPayloadFromHash(hash)).toBe('payload');
    expect(runtimeImportSourceFromHash(hash)).toBe('/api/runtime-import');
    expect(removeRemoteRuntimeImportParams(
      `https://xln.local/app?runtime-import=secret&keep=1${hash}&tab=settings`,
    )).toBe('/app?keep=1#tab=settings');
  });

  test('keeps consent and capability-role decisions deterministic', () => {
    const request = {
      wsUrl: 'wss://runtime.example/rpc',
      authKey: ADMIN_TOKEN,
      hostLabel: 'runtime',
      keyLabel: 'full capability',
      acceptKey: 'accept',
      requiresAuthPaste: false,
    };
    expect(remoteRuntimeRequestRequiresConsent(request, false)).toBe(true);
    expect(remoteRuntimeRequestRequiresConsent(request, true)).toBe(false);
    expect(remoteRuntimeRequestRequiresConsent({ ...request, requiresAuthPaste: true }, true)).toBe(true);
    expect(remoteAccessFromAuthKey(ADMIN_TOKEN)).toBe('admin');
    expect(() => remoteAccessFromAuthKey('xlnra1.read.payload'))
      .toThrow('REMOTE_RUNTIME_ADMIN_CAPABILITY_REQUIRED');
  });

  test('keeps Svelte on thin adapters instead of duplicate request logic', () => {
    const connection = readFileSync('frontend/src/lib/utils/runtime/runtimeConnection.ts', 'utf8');
    const legacyWsUrl = readFileSync('frontend/src/lib/utils/runtime/wsUrl.ts', 'utf8');

    expect(connection).toContain("from '../../../../packages/runtime-client/src/remote-runtime-request'");
    expect(connection).toContain('decodeRemoteRuntimeRequest(');
    expect(connection).toContain('removeRemoteRuntimeImportParams(window.location.href)');
    expect(connection).not.toContain('const RUNTIME_PARAM_KEYS');
    expect(legacyWsUrl).toContain("from '../../../../packages/runtime-client/src/ws-url'");
    expect(legacyWsUrl).not.toContain('const normalizeLoopbackHost');
  });
});
