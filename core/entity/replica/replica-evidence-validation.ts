import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import { validateProposedEntityFrame } from '../consensus/frame/validation';

export const validateReplicaJHistory = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  const history = validateObject(value, `${context}.jHistory`);
  validateString(history['jurisdictionRef'], `${context}.jHistory.jurisdictionRef`);
  const scanned = validateNumber(
    history['scannedThroughHeight'],
    `${context}.jHistory.scannedThroughHeight`,
  );
  if (!Number.isSafeInteger(scanned) || scanned < 0) {
    throw new FinancialDataCorruptionError(
      `${context}.jHistory.scannedThroughHeight must be non-negative`,
    );
  }
  validateString(history['tipBlockHash'], `${context}.jHistory.tipBlockHash`);
  const eventBlocks = validateMapInstance(
    history['eventBlocks'],
    `${context}.jHistory.eventBlocks`,
  );
  for (const [height, rawBlock] of eventBlocks) {
    if (!Number.isSafeInteger(height) || Number(height) <= 0) {
      throw new FinancialDataCorruptionError(
        `${context}.jHistory.eventBlocks key must be positive`,
      );
    }
    const item = `${context}.jHistory.eventBlocks[${String(height)}]`;
    const block = validateObject(rawBlock, item);
    validateString(block['jurisdictionRef'], `${item}.jurisdictionRef`);
    if (validateNumber(block['jHeight'], `${item}.jHeight`) !== height) {
      throw new FinancialDataCorruptionError(
        `${context}.jHistory event block height must match key`,
      );
    }
    validateString(block['jBlockHash'], `${item}.jBlockHash`);
    validateString(block['eventsHash'], `${item}.eventsHash`);
    validateArray(block['events'], `${item}.events`);
  }
  const hashes = validateMapInstance(
    history['blockHashes'],
    `${context}.jHistory.blockHashes`,
  );
  for (const [height, hash] of hashes) {
    if (
      !Number.isSafeInteger(height) ||
      Number(height) <= 0 ||
      typeof hash !== 'string' ||
      hash.length === 0
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.jHistory.blockHashes entries invalid`,
      );
    }
  }
};

export const validateReplicaLineageAndWitnesses = (
  replica: Record<string, unknown>,
  context: string,
): void => {
  if (replica['certifiedFrameHead'] !== undefined) {
    const item = `${context}.certifiedFrameHead`;
    const link = validateObject(replica['certifiedFrameHead'], item);
    validateProposedEntityFrame(link['frame'], `${item}.frame`);
    const authority = validateObject(link['postAuthority'], `${item}.postAuthority`);
    validateObject(authority['config'], `${item}.postAuthority.config`);
    validateObject(authority['leaderState'], `${item}.postAuthority.leaderState`);
  }
  if (replica['hankoWitness'] === undefined) return;
  const witnesses = validateMapInstance(
    replica['hankoWitness'],
    `${context}.hankoWitness`,
  );
  for (const [hash, value] of witnesses) {
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new FinancialDataCorruptionError(
        `${context}.hankoWitness key must be non-empty`,
      );
    }
    const item = `${context}.hankoWitness[${hash}]`;
    const witness = validateObject(value, item);
    validateString(witness['hanko'], `${item}.hanko`);
    validateString(witness['type'], `${item}.type`);
    validateNumber(witness['entityHeight'], `${item}.entityHeight`);
    validateNumber(witness['createdAt'], `${item}.createdAt`);
  }
};
