#!/usr/bin/env bun

/**
 * Canonical audit-registry CLI.
 *
 * Commands:
 *   bun tools/audit.ts verify      Validate schema, references, and source globs.
 *   bun tools/audit.ts status      Derive coverage, quality, state, and agent ledger.
 *   bun tools/audit.ts plan        Rank missing invariant evidence and open findings.
 *   bun tools/audit.ts fingerprint [module-id] [--json]
 *   bun tools/audit.ts gate <merge|release> [--json]
 *
 * Percentages are always derived from audits/registry.json plus current module
 * fingerprints. This tool never edits the registry or silently blesses stale
 * evidence.
 */

import { resolve } from 'node:path';

import {
  computeAuditStatus,
  computeEnvironmentFingerprint,
  computeModuleFingerprints,
  evaluateAuditGate,
  loadAuditRegistry,
  readCurrentSha,
  validateAuditRegistry,
} from './audit/core';
import type { AuditRegistry, ModuleCriticality } from './audit/types';

const ROOT = resolve(import.meta.dir, '..');
const DEFAULT_REGISTRY = resolve(ROOT, 'audits/registry.json');

type CliArgs = Readonly<{
  command: string;
  registryPath: string;
  json: boolean;
  positional: readonly string[];
}>;

const parseArgs = (argv: readonly string[]): CliArgs => {
  const command = argv.find(argument => !argument.startsWith('--')) ?? 'status';
  const positional = argv.filter(argument => !argument.startsWith('--')).slice(1);
  const registryValue = argv.find(argument => argument.startsWith('--registry='))?.slice('--registry='.length);
  return {
    command,
    registryPath: resolve(ROOT, registryValue || DEFAULT_REGISTRY),
    json: argv.includes('--json'),
    positional,
  };
};

const criticalityOrder: Readonly<Record<ModuleCriticality, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const printAgentLedger = (registry: AuditRegistry): void => {
  const completed = registry.agentRuns.filter(run => run.state === 'COMPLETED').length;
  const running = registry.agentRuns.filter(run => run.state === 'RUNNING').length;
  console.log(`\nAGENTS total=${registry.agentRuns.length} completed=${completed} active=${running}`);
  const reviewers = new Map(registry.reviewers.map(reviewer => [reviewer.id, reviewer]));
  for (const run of [...registry.agentRuns].sort((left, right) => right.usefulnessScore - left.usefulnessScore)) {
    const marker = run.provisional ? 'PROVISIONAL' : 'ADJUDICATED';
    console.log(`${String(run.usefulnessScore).padStart(4)}  ${marker.padEnd(12)}  ${reviewers.get(run.reviewerId)?.label ?? run.reviewerId} · ${run.scope}`);
  }
};

const nextModuleStep = (
  registry: AuditRegistry,
  invariantStatuses: ReadonlyMap<string, { missingEvidence: readonly string[] }>,
  moduleId: string,
): string => {
  const owned = new Set(registry.invariants.filter(invariant => invariant.moduleId === moduleId).map(invariant => invariant.id));
  const finding = registry.findings.find(candidate => (
    candidate.state !== 'REJECTED'
    && candidate.state !== 'VERIFIED'
    && (candidate.moduleId === moduleId || candidate.invariantIds.some(invariantId => owned.has(invariantId)))
  ));
  if (finding) return `fix:${finding.id}`;
  const gap = registry.invariants
    .filter(invariant => invariant.moduleId === moduleId)
    .map(invariant => ({ invariant, status: invariantStatuses.get(invariant.id) }))
    .find(item => (item.status?.missingEvidence.length ?? 0) > 0);
  if (!gap?.status) return 'complete';
  return `${gap.invariant.id}:${gap.status.missingEvidence[0]}`;
};

const statusCommand = (registry: AuditRegistry, json: boolean): void => {
  const fingerprints = computeModuleFingerprints(ROOT, registry);
  const status = computeAuditStatus(
    registry,
    fingerprints,
    readCurrentSha(ROOT),
    computeEnvironmentFingerprint(ROOT),
  );
  if (json) {
    console.log(JSON.stringify({ status, agentRuns: registry.agentRuns }, null, 2));
    return;
  }
  console.log(`AUDIT STATUS sha=${status.sourceSha.slice(0, 10)} coverage=${status.coverage}% quality=${status.quality}% evidence=${status.currentEvidence} current/${status.staleEvidence} stale`);
  console.log('COV    QUAL   LEFT   P0/1  STATE       CRIT      MODULE · NEXT');
  const invariantStatuses = new Map(status.invariants.map(invariant => [invariant.id, invariant]));
  const modules = [...status.modules].sort((left, right) => (
    criticalityOrder[left.criticality] - criticalityOrder[right.criticality]
    || left.coverage - right.coverage
    || left.id.localeCompare(right.id)
  ));
  for (const module of modules) {
    console.log(`${`${module.coverage}%`.padStart(5)}  ${`${module.quality}%`.padStart(5)}  ${`${100 - module.quality}%`.padStart(5)}  ${String(module.openHighFindings).padStart(4)}  ${module.state.padEnd(10)}  ${module.criticality.padEnd(8)}  ${module.id} · ${nextModuleStep(registry, invariantStatuses, module.id)}`);
  }
  printAgentLedger(registry);
};

const verifyCommand = (registry: AuditRegistry, json: boolean): void => {
  const errors = validateAuditRegistry(registry, ROOT);
  const fingerprints = errors.length === 0 ? computeModuleFingerprints(ROOT, registry) : new Map<string, string>();
  const environmentFingerprint = computeEnvironmentFingerprint(ROOT);
  const stale = registry.evidence.filter(item => {
    const invariant = registry.invariants.find(candidate => candidate.id === item.invariantId);
    return invariant
      ? fingerprints.get(invariant.moduleId) !== item.moduleFingerprint
        || item.environmentFingerprint !== environmentFingerprint
      : true;
  });
  const result = {
    ok: errors.length === 0 && stale.length === 0,
    modules: registry.modules.length,
    invariants: registry.invariants.length,
    evidence: registry.evidence.length,
    staleEvidence: stale.length,
    findings: registry.findings.length,
    agentRuns: registry.agentRuns.length,
    errors,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(`AUDIT_REGISTRY_OK modules=${result.modules} invariants=${result.invariants} evidence=${result.evidence} stale=${result.staleEvidence} findings=${result.findings} agents=${result.agentRuns}`);
  } else if (errors.length === 0) {
    console.error(`AUDIT_REGISTRY_STALE evidence=${result.staleEvidence}`);
  } else {
    console.error(`AUDIT_REGISTRY_INVALID errors=${errors.length}`);
    for (const error of errors) console.error(`- ${error}`);
  }
  if (!result.ok) process.exitCode = 1;
};

const gateCommand = (registry: AuditRegistry, args: CliArgs): void => {
  const profile = args.positional[0];
  if (profile !== 'merge' && profile !== 'release') {
    throw new Error(`AUDIT_GATE_PROFILE_UNKNOWN:${String(profile)}`);
  }
  const fingerprints = computeModuleFingerprints(ROOT, registry);
  const status = computeAuditStatus(
    registry,
    fingerprints,
    readCurrentSha(ROOT),
    computeEnvironmentFingerprint(ROOT),
  );
  const result = evaluateAuditGate(registry, status, profile);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`AUDIT_${profile.toUpperCase()}_GATE_OK`);
  else {
    console.error(`AUDIT_${profile.toUpperCase()}_GATE_BLOCKED failures=${result.failures.length}`);
    for (const failure of result.failures) console.error(`- ${failure}`);
  }
  if (!result.ok) process.exitCode = 1;
};

const planCommand = (registry: AuditRegistry, json: boolean): void => {
  const fingerprints = computeModuleFingerprints(ROOT, registry);
  const status = computeAuditStatus(
    registry,
    fingerprints,
    readCurrentSha(ROOT),
    computeEnvironmentFingerprint(ROOT),
  );
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  const invariantStatuses = new Map(status.invariants.map(invariant => [invariant.id, invariant]));
  const severityRank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  const findings = registry.findings
    .filter(finding => finding.state !== 'REJECTED' && finding.state !== 'VERIFIED')
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.confidence - left.confidence);
  const gaps = registry.invariants
    .map(invariant => {
      const current = invariantStatuses.get(invariant.id)!;
      const criticality = modules.get(invariant.moduleId)?.criticality ?? 'low';
      const multiplier = 4 - criticalityOrder[criticality];
      return {
        id: invariant.id,
        moduleId: invariant.moduleId,
        coverage: current.coverage,
        missingEvidence: current.missingEvidence,
        priority: Math.round(invariant.importance * multiplier * (1 - current.coverage / 100)),
      };
    })
    .filter(gap => gap.missingEvidence.length > 0)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  if (json) {
    console.log(JSON.stringify({ findings, gaps }, null, 2));
    return;
  }
  console.log(`AUDIT PLAN open-findings=${findings.length} evidence-gaps=${gaps.length}`);
  for (const finding of findings) {
    console.log(`${finding.severity} ${String(finding.confidence).padStart(3)}% ${finding.state.padEnd(10)} ${finding.id} · ${finding.title}`);
  }
  for (const gap of gaps.slice(0, 20)) {
    console.log(`GAP ${String(gap.priority).padStart(3)} ${`${gap.coverage}%`.padStart(6)} ${gap.id} · ${gap.missingEvidence.join(',')}`);
  }
};

const fingerprintCommand = (registry: AuditRegistry, args: CliArgs): void => {
  const fingerprints = computeModuleFingerprints(ROOT, registry);
  const requested = args.positional[0];
  if (requested && !fingerprints.has(requested)) throw new Error(`AUDIT_MODULE_UNKNOWN:${requested}`);
  const output = requested
    ? { [requested]: fingerprints.get(requested) }
    : Object.fromEntries([...fingerprints].sort(([left], [right]) => left.localeCompare(right)));
  if (args.json || !requested) console.log(JSON.stringify(output, null, 2));
  else console.log(`${requested} ${fingerprints.get(requested)}`);
};

export const runAuditCli = (argv = process.argv.slice(2)): void => {
  const args = parseArgs(argv);
  const registry = loadAuditRegistry(args.registryPath);
  if (args.command === 'verify') return verifyCommand(registry, args.json);
  const errors = validateAuditRegistry(registry, ROOT);
  if (errors.length > 0) throw new Error(`AUDIT_REGISTRY_INVALID\n${errors.join('\n')}`);
  if (args.command === 'status') return statusCommand(registry, args.json);
  if (args.command === 'plan') return planCommand(registry, args.json);
  if (args.command === 'fingerprint') return fingerprintCommand(registry, args);
  if (args.command === 'gate') return gateCommand(registry, args);
  throw new Error(`AUDIT_COMMAND_UNKNOWN:${args.command}`);
};

if (import.meta.main) runAuditCli();
