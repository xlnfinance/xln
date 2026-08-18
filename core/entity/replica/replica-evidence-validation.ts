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

export const validateCertifiedFrameAnchor = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  const anchor = validateObject(value, `${context}.certifiedFrameAnchor`);
  validateString(anchor['entityId'], `${context}.certifiedFrameAnchor.entityId`);
  validateNumber(anchor['height'], `${context}.certifiedFrameAnchor.height`);
  validateString(anchor['frameHash'], `${context}.certifiedFrameAnchor.frameHash`);
  validateString(anchor['stateRoot'], `${context}.certifiedFrameAnchor.stateRoot`);
  if (anchor['authorityEvidenceHash'] !== undefined) {
    const hash = validateString(
      anchor['authorityEvidenceHash'],
      `${context}.certifiedFrameAnchor.authorityEvidenceHash`,
    );
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new FinancialDataCorruptionError(
        `${context}.certifiedFrameAnchor.authorityEvidenceHash must be bytes32`,
      );
    }
  }
  if (anchor['runtimeCheckpoint'] !== undefined) {
    const checkpoint = validateObject(
      anchor['runtimeCheckpoint'],
      `${context}.certifiedFrameAnchor.runtimeCheckpoint`,
    );
    const height = validateNumber(
      checkpoint['runtimeHeight'],
      `${context}.certifiedFrameAnchor.runtimeCheckpoint.runtimeHeight`,
    );
    const root = validateString(
      checkpoint['replicaSetRoot'],
      `${context}.certifiedFrameAnchor.runtimeCheckpoint.replicaSetRoot`,
    );
    if (
      !Number.isSafeInteger(height) ||
      height < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(root)
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.certifiedFrameAnchor.runtimeCheckpoint invalid`,
      );
    }
  }
  const authority = validateObject(
    anchor['authority'],
    `${context}.certifiedFrameAnchor.authority`,
  );
  validateObject(
    authority['config'],
    `${context}.certifiedFrameAnchor.authority.config`,
  );
  validateObject(
    authority['leaderState'],
    `${context}.certifiedFrameAnchor.authority.leaderState`,
  );
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
