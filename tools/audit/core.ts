/** Stable import surface for the canonical audit registry implementation. */

export {
  computeModuleFingerprint,
  computeModuleFingerprints,
  computeEnvironmentFingerprint,
  computeFileFingerprint,
  listCurrentSourceFiles,
  listModuleFingerprintFiles,
  matchesAuditGlob,
  readCurrentSha,
  sha256Text,
} from './fingerprint';

export { computeAuditStatus, evaluateAuditGate } from './status';
export { computeModuleReviewStatus } from './reviews';
export { validateEvidenceArtifactBinding } from './root-validation';

export {
  loadAuditRegistry,
  parseAuditRegistry,
  validateAuditRegistry,
} from './validation';
