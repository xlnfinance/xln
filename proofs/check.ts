import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLAIM_IDS = Array.from({ length: 10 }, (_, index) => `C${index + 1}`);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EVIDENCE_STATUSES = new Set(['bounded', 'missing', 'planned']);
const AUDIT_KINDS = new Set(['adversary', 'repro']);

type JsonObject = Record<string, unknown>;
type PathExists = (path: string) => boolean;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;

const validateSha = (value: unknown, field: string, errors: string[]): void => {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) errors.push(`${field}: expected full lowercase SHA`);
};

const validatePath = (value: string, root: string, pathExists: PathExists, errors: string[]): void => {
  if (value.startsWith('/') || value.split('/').includes('..')) {
    errors.push(`unsafe evidence path: ${value}`);
    return;
  }
  if (!pathExists(resolve(root, value))) errors.push(`missing evidence path: ${value}`);
};

const validateMetrics = (value: unknown, id: string, errors: string[]): void => {
  if (!isObject(value)) return errors.push(`${id}.metrics: expected object`);
  for (const [name, metric] of Object.entries(value)) {
    if (!Number.isSafeInteger(metric) || Number(metric) < 0) errors.push(`${id}.metrics.${name}: expected non-negative safe integer`);
  }
};

const validateAudits = (
  value: unknown,
  root: string,
  pathExists: PathExists,
  errors: string[],
): Map<string, JsonObject> => {
  const audits = new Map<string, JsonObject>();
  if (!Array.isArray(value)) {
    errors.push('audits: expected array');
    return audits;
  }
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.id !== 'string') {
      errors.push('audit: expected object with string id');
      continue;
    }
    if (audits.has(raw.id)) errors.push(`duplicate audit id: ${raw.id}`);
    if (!AUDIT_KINDS.has(String(raw.kind))) errors.push(`${raw.id}.kind: invalid`);
    validateSha(raw.subjectSha, `${raw.id}.subjectSha`, errors);
    if (typeof raw.report !== 'string') errors.push(`${raw.id}.report: expected string`);
    else validatePath(raw.report, root, pathExists, errors);
    const claims = stringArray(raw.claims);
    if (!claims?.length || claims.some(id => !CLAIM_IDS.includes(id))) errors.push(`${raw.id}.claims: invalid`);
    if (typeof raw.matchesEvidenceAnchor !== 'boolean') errors.push(`${raw.id}.matchesEvidenceAnchor: expected boolean`);
    audits.set(raw.id, raw);
  }
  return audits;
};

const validateClaimIdentity = (claim: JsonObject, expectedId: string, errors: string[]): void => {
  if (claim.id !== expectedId) errors.push(`claim order/id: expected ${expectedId}, received ${String(claim.id)}`);
  const expectedPhase = Number(expectedId.slice(1)) <= 8 ? 1 : 2;
  if (claim.phase !== expectedPhase) errors.push(`${expectedId}.phase: expected ${expectedPhase}`);
  if (!EVIDENCE_STATUSES.has(String(claim.evidenceStatus))) errors.push(`${expectedId}.evidenceStatus: invalid`);
  if (typeof claim.complete !== 'boolean') errors.push(`${expectedId}.complete: expected boolean`);
};

const validateClaimEvidence = (
  claim: JsonObject,
  id: string,
  root: string,
  pathExists: PathExists,
  errors: string[],
): void => {
  const evidence = stringArray(claim.evidence);
  if (!evidence) return errors.push(`${id}.evidence: expected string array`);
  for (const path of evidence) validatePath(path, root, pathExists, errors);
  if (claim.evidenceStatus === 'bounded' && evidence.length === 0) errors.push(`${id}: bounded claim has no evidence`);
  if (evidence.length > 0) validateSha(claim.evidenceSha, `${id}.evidenceSha`, errors);
  const risks = stringArray(claim.residualRisks);
  if (!risks?.length) errors.push(`${id}.residualRisks: must be explicit`);
  validateMetrics(claim.metrics, id, errors);
};

const validateClaimAudits = (
  claim: JsonObject,
  id: string,
  audits: Map<string, JsonObject>,
  requiredKinds: string[],
  errors: string[],
): void => {
  const auditIds = stringArray(claim.auditIds);
  if (!auditIds) return errors.push(`${id}.auditIds: expected string array`);
  const linked = auditIds.map(auditId => audits.get(auditId));
  auditIds.forEach((auditId, index) => {
    const audit = linked[index];
    if (!audit) errors.push(`${id}: unknown audit ${auditId}`);
    else if (!stringArray(audit.claims)?.includes(id)) errors.push(`${id}: audit ${auditId} lacks reciprocal claim link`);
  });
  if (claim.complete !== true) return;
  const currentKinds = new Set(linked.filter(audit => audit?.matchesEvidenceAnchor === true).map(audit => String(audit?.kind)));
  for (const kind of requiredKinds) if (!currentKinds.has(kind)) errors.push(`${id}: complete without current ${kind} audit`);
};

const validateClaims = (
  value: unknown,
  root: string,
  pathExists: PathExists,
  audits: Map<string, JsonObject>,
  requiredKinds: string[],
  errors: string[],
): JsonObject[] => {
  if (!Array.isArray(value)) {
    errors.push('claims: expected array');
    return [];
  }
  if (value.length !== CLAIM_IDS.length) errors.push(`claims: expected ${CLAIM_IDS.length}, received ${value.length}`);
  const claims = value.filter(isObject);
  claims.forEach((claim, index) => {
    const id = CLAIM_IDS[index] ?? `claim[${index}]`;
    validateClaimIdentity(claim, id, errors);
    validateClaimEvidence(claim, id, root, pathExists, errors);
    validateClaimAudits(claim, id, audits, requiredKinds, errors);
  });
  return claims;
};

export const validateProofProgram = (input: unknown, root: string, pathExists: PathExists = existsSync): string[] => {
  const errors: string[] = [];
  if (!isObject(input)) return ['program: expected object'];
  if (input.schemaVersion !== 1) errors.push('schemaVersion: expected 1');
  validateSha(input.programRangeStart, 'programRangeStart', errors);
  validateSha(input.evidenceAnchorSha, 'evidenceAnchorSha', errors);
  const requiredKinds = stringArray(input.requiredAuditKinds) ?? [];
  if (requiredKinds.join(',') !== 'adversary,repro') errors.push('requiredAuditKinds: expected adversary,repro');
  const audits = validateAudits(input.audits, root, pathExists, errors);
  const claims = validateClaims(input.claims, root, pathExists, audits, requiredKinds, errors);
  const allComplete = claims.length === CLAIM_IDS.length && claims.every(claim => claim.complete === true);
  if (input.releaseClaimAllowed !== allComplete) errors.push('releaseClaimAllowed must equal the all-claims-complete state');
  return errors;
};

export const loadProofProgram = (root: string): unknown =>
  JSON.parse(readFileSync(resolve(root, 'proofs/program.json'), 'utf8')) as unknown;

const run = (): void => {
  const root = resolve(import.meta.dir, '..');
  const program = loadProofProgram(root);
  const errors = validateProofProgram(program, root);
  if (errors.length > 0) throw new Error(`PROOF_PROGRAM_INVALID\n${errors.map(error => `- ${error}`).join('\n')}`);
  const manifest = program as { claims: JsonObject[]; audits: JsonObject[] };
  const complete = manifest.claims.filter(claim => claim.complete === true).length;
  console.log(`PROOF_PROGRAM_OK claims=${manifest.claims.length} complete=${complete} audits=${manifest.audits.length}`);
};

if (import.meta.main) run();
