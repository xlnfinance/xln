/** Stable import surface for the canonical audit registry implementation. */

export {
  computeModuleFingerprints,
  computeEnvironmentFingerprint,
  listCurrentSourceFiles,
  listModuleFingerprintFiles,
  matchesAuditGlob,
  readCurrentSha,
  sha256Text,
} from './fingerprint';

export { computeAuditStatus, evaluateAuditGate } from './status';
export {
  validateEvidenceArtifactBinding,
  validateInvariantCoverage,
} from './root-validation';

export {
  loadAuditRegistry,
  parseAuditRegistry,
  validateAuditRegistry,
} from './validation';
