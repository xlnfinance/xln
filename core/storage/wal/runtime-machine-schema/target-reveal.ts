import { toEntityId, toSignerId } from '../../../protocol/identity';
import {
  requireArray,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../../protocol/boundary/boundary-primitives';

const word = (value: unknown, code: string): void => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(requireString(value, code))) throw new Error(code);
};

/** Decode the current standalone beneficiary-authorized publication on restart. */
export const validateTargetRevealData = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['registration', 'revealHash', 'signerId'],
    ['hankoSignature', 'runtimeSubmitAttempt'], `${code}_FIELDS`);
  word(data['revealHash'], `${code}_HASH`);
  toSignerId(requireString(data['signerId'], `${code}_SIGNER`));
  if (data['hankoSignature'] !== undefined
    && !/^0x(?:[0-9a-fA-F]{2})+$/.test(requireString(data['hankoSignature'], `${code}_HANKO`))) {
    throw new Error(`${code}_HANKO`);
  }
  const registration = requireBoundaryRecord(data['registration'], `${code}_REGISTRATION`);
  requireExactBoundaryKeys(registration,
    ['counterpartyEntity', 'targetRole', 'fullHash', 'partialRoot', 'witness'], [], `${code}_REGISTRATION_FIELDS`);
  toEntityId(requireString(registration['counterpartyEntity'], `${code}_COUNTERPARTY`));
  if (registration['targetRole'] !== true) throw new Error(`${code}_TARGET_ROLE`);
  word(registration['fullHash'], `${code}_FULL_HASH`);
  word(registration['partialRoot'], `${code}_PARTIAL_ROOT`);
  const witness = requireBoundaryRecord(registration['witness'], `${code}_WITNESS`);
  requireExactBoundaryKeys(witness, ['fillRatio', 'fullSecret', 'reveals'], [], `${code}_WITNESS_FIELDS`);
  const ratio = requireBoundaryInteger(witness['fillRatio'], `${code}_RATIO`, 1);
  if (ratio > 65535) throw new Error(`${code}_RATIO`);
  word(witness['fullSecret'], `${code}_SECRET`);
  const reveals = requireArray(witness['reveals'], `${code}_REVEALS`);
  if (reveals.length !== 4) throw new Error(`${code}_REVEALS_LENGTH`);
  for (const reveal of reveals) word(reveal, `${code}_REVEAL`);
};
