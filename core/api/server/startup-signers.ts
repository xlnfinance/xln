/** Decode the private signer inventory delivered over the managed-child secret pipe. */

import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { RuntimeLocalSigner } from '../../runtime/replica/bootstrap';

const MAX_STARTUP_SIGNERS = 256;

const requireNonBlankString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
};

export const decodeStartupSigners = (raw: string | undefined): readonly RuntimeLocalSigner[] => {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('STARTUP_SIGNERS_JSON_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_STARTUP_SIGNERS) {
    throw new Error('STARTUP_SIGNERS_ARRAY_INVALID');
  }
  const labels = new Set<string>();
  return parsed.map((value, index) => {
    const record = requireBoundaryRecord(value, `STARTUP_SIGNER_INVALID:${index}`);
    requireExactBoundaryKeys(
      record,
      ['seed', 'label'],
      [],
      `STARTUP_SIGNER_FIELDS_INVALID:${index}`,
    );
    const seed = requireNonBlankString(record['seed'], `STARTUP_SIGNER_SEED_INVALID:${index}`);
    const label = requireNonBlankString(record['label'], `STARTUP_SIGNER_LABEL_INVALID:${index}`).trim();
    if (labels.has(label)) throw new Error(`STARTUP_SIGNER_LABEL_DUPLICATE:${label}`);
    labels.add(label);
    return { seed, label };
  });
};
