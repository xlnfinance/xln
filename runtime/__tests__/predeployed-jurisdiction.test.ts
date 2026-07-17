import { describe, expect, test } from 'bun:test';
import { selectPredeployedJurisdiction } from '../server/predeployed-jurisdiction';

const complete = (rpc: string, primary = false) => ({
  rpc,
  primary,
  entityProviderDeploymentBlock: 1,
  contracts: {
    account: '0x0000000000000000000000000000000000000003',
    depository: '0x0000000000000000000000000000000000000001',
    entityProvider: '0x0000000000000000000000000000000000000002',
    deltaTransformer: '0x0000000000000000000000000000000000000004',
  },
});

describe('predeployed jurisdiction selection', () => {
  test('uses an explicit complete key and rejects missing or incomplete keys', () => {
    const payload = {
      jurisdictions: {
        ethereum: complete('/rpc'),
        incomplete: { contracts: { depository: '0x1' } },
      },
    };
    expect(selectPredeployedJurisdiction(payload, '/rpc', 'ethereum')).toBe(payload.jurisdictions.ethereum);
    expect(() => selectPredeployedJurisdiction(payload, '/rpc', 'missing'))
      .toThrow('PREDEPLOYED_JURISDICTION_NOT_FOUND:missing');
    expect(() => selectPredeployedJurisdiction(payload, '/rpc', 'incomplete'))
      .toThrow('PREDEPLOYED_JURISDICTION_INCOMPLETE:incomplete');
  });

  test('requires unique implicit selection at every precedence level', () => {
    const rpcMatch = complete('http://127.0.0.1:8545');
    expect(selectPredeployedJurisdiction({
      jurisdictions: { rpcMatch, other: complete('/rpc2', true) },
    }, 'http://localhost:8545')).toBe(rpcMatch);

    expect(() => selectPredeployedJurisdiction({
      jurisdictions: { left: complete('/rpc'), right: complete('/rpc') },
    }, 'http://localhost:8545')).toThrow('PREDEPLOYED_JURISDICTION_AMBIGUOUS:rpc:2');

    const primary = complete('/primary', true);
    expect(selectPredeployedJurisdiction({
      jurisdictions: { primary, other: complete('/other') },
    }, '/no-match')).toBe(primary);

    expect(() => selectPredeployedJurisdiction({
      jurisdictions: { left: complete('/left', true), right: complete('/right', true) },
    }, '/no-match')).toThrow('PREDEPLOYED_JURISDICTION_AMBIGUOUS:primary:2');

    expect(() => selectPredeployedJurisdiction({
      jurisdictions: { left: complete('/left'), right: complete('/right') },
    }, '/no-match')).toThrow('PREDEPLOYED_JURISDICTION_AMBIGUOUS:fallback:2');
  });

  test('ignores a pending same-RPC alias without a complete deployed stack', () => {
    const active = complete('/rpc');
    const pending = {
      rpc: '/rpc',
      contracts: {
        depository: '0x0000000000000000000000000000000000000005',
        entityProvider: '0x0000000000000000000000000000000000000006',
      },
    };
    expect(selectPredeployedJurisdiction({
      jurisdictions: { active, pending },
    }, 'http://localhost:8545')).toBe(active);
  });

  test('rejects an invalid map and returns null only when no map exists', () => {
    expect(() => selectPredeployedJurisdiction({ jurisdictions: [] }, '/rpc'))
      .toThrow('PREDEPLOYED_JURISDICTIONS_INVALID');
    expect(selectPredeployedJurisdiction({}, '/rpc')).toBeNull();
  });
});
