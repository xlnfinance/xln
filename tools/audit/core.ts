/** Stable import surface for the canonical audit registry implementation. */

export {
  computeModuleFingerprint,
  computeModuleFingerprints,
  computeEnvironmentFingerprint,
  computeFileFingerprint,
  listCurrentSourceFiles,
  listModuleFingerprintFiles,
  isModuleFileExcluded,
  matchesAuditGlob,
  readCurrentSha,
  sha256Text,
} from './fingerprint';

export { computeAuditStatus, evaluateAuditGate } from './status';
export { computeModuleReviewStatus } from './reviews';
export {
  validateEvidenceArtifactBinding,
  validateInvariantCoverage,
} from './root-validation';

export {
  loadAuditRegistry,
  parseAuditRegistry,
  validateAuditRegistry,
} from './validation';
