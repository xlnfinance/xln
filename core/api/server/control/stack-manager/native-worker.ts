// Private operator IPC only; keys arrive on stdin and never enter HTTP or logs.
import { deployJurisdictionStack, probeJurisdictionStackTarget } from '../../../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../../../jurisdiction/adapter/stack-manager/validation';
import { getConfiguredOfficialFoundationSignerId } from '../../../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { getAddress, isAddress } from 'ethers';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';

const emit = (value: unknown): void => { process.stdout.write(`${safeStringify(value)}\n`); };
let privateKey = '';
try {
  const text = await Bun.stdin.text();
  if (text.length > 64 * 1024) throw new Error('STACK_MANAGER_PRIVATE_INPUT_LIMIT');
  const raw: unknown = JSON.parse(text);
  const input = requireBoundaryRecord(raw, 'STACK_MANAGER_PRIVATE_INPUT_INVALID');
  if (input['op'] === 'probe') {
    requireExactBoundaryKeys(input, ['op', 'rpcUrl', 'signerId'], [], 'STACK_MANAGER_PRIVATE_FIELDS_INVALID');
    if (typeof input['rpcUrl'] !== 'string' || typeof input['signerId'] !== 'string' || !isAddress(input['signerId'])) throw new Error('STACK_MANAGER_PROBE_QUERY_INVALID');
    const url = new URL(input['rpcUrl']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('STACK_MANAGER_PROBE_QUERY_INVALID');
    emit({ type: 'result', value: await probeJurisdictionStackTarget({ rpcUrl: input['rpcUrl'], signerId: getAddress(input['signerId']).toLowerCase() }) });
  } else if (input['op'] === 'deploy') {
    requireExactBoundaryKeys(input, ['op', 'request', 'signerPrivateKey'], [], 'STACK_MANAGER_PRIVATE_FIELDS_INVALID');
    if (typeof input['signerPrivateKey'] !== 'string') throw new Error('STACK_MANAGER_PRIVATE_SIGNER_INVALID');
    privateKey = input['signerPrivateKey'];
    const request = decodeDeployJurisdictionStackRequest(input['request']);
    if (!/^0x[0-9a-f]{64}$/.test(privateKey)) throw new Error('STACK_MANAGER_PRIVATE_SIGNER_INVALID');
    const officialFoundationSignerId = getConfiguredOfficialFoundationSignerId();
    const result = await deployJurisdictionStack(request, {
      signerPrivateKey: Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')),
      ...(officialFoundationSignerId ? { officialFoundationSignerId } : {}),
      onPhase: phase => emit({ type: 'phase', phase, updatedAt: new Date().toISOString() }),
    });
    emit({ type: 'result', value: result });
  } else throw new Error('STACK_MANAGER_PRIVATE_OPERATION_INVALID');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: 'error', error: privateKey ? message.replaceAll(privateKey, '[redacted]').replaceAll(privateKey.slice(2), '[redacted]') : message });
  process.exitCode = 1;
}
