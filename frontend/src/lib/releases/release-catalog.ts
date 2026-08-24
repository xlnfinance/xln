import { marked } from 'marked';

import { sanitizeRenderedHtml } from '$lib/security/safe-markdown';
import {
  readJsonUnknown,
  rejectExtraKeys,
  requireFiniteNumber,
  requireString,
  requireUnknownRecord,
} from '$lib/utils/boundary';
import {
  verifyReleaseManifestEntry,
  verifyReleaseManifestPolicy,
  verifyReleaseManifestSnapshotBinding,
  type ReleaseAttestation,
  type ReleaseSnapshotClaim,
} from './release-signature';

export type ReleaseMetrics = Readonly<Record<string, number>> & Readonly<{
  code: number;
  complexity: number;
  files: number;
  testCode: number;
  testCodeRatio: number;
}>;

export type ReleaseEntry = Readonly<{
  version: string;
  tag: string;
  generatedAt: string;
  markdown: string;
  snapshot: string;
  sourceCommit: string;
  metrics: ReleaseMetrics;
  modules: Readonly<Record<string, ReleaseMetrics>>;
  codeSnapshotRoot?: string;
  frozenCore?: Readonly<{ rootHash: string }>;
  attestation?: ReleaseAttestation;
}>;

export type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  latest: string;
  releases: readonly ReleaseEntry[];
}>;

export type ReleaseMetricKey = keyof Pick<ReleaseMetrics, 'code' | 'complexity' | 'files' | 'testCode' | 'testCodeRatio'>;

export const RELEASE_METRICS: readonly Readonly<{ key: ReleaseMetricKey; label: string }>[] = [
  { key: 'code', label: 'Code LOC' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'files', label: 'Files' },
  { key: 'testCode', label: 'Test LOC' },
  { key: 'testCodeRatio', label: 'Test / source' },
] as const;

const decodeMetricsRecord = (value: unknown, code: string): Record<string, number> => {
  const record = requireUnknownRecord(value, `${code}_INVALID`);
  const entries = Object.entries(record);
  if (!entries.length) throw new Error(`${code}_EMPTY`);
  return Object.fromEntries(entries.map(([key, metric]) => [key, requireFiniteNumber(metric, `${code}_${key}_INVALID`)]));
};

const decodeReleaseMetrics = (value: unknown, code: string): ReleaseMetrics => {
  const metrics = decodeMetricsRecord(value, code);
  return {
    ...metrics,
    code: requireFiniteNumber(metrics['code'], `${code}_CODE_INVALID`),
    complexity: requireFiniteNumber(metrics['complexity'], `${code}_COMPLEXITY_INVALID`),
    files: requireFiniteNumber(metrics['files'], `${code}_FILES_INVALID`),
    testCode: requireFiniteNumber(metrics['testCode'], `${code}_TEST_CODE_INVALID`),
    testCodeRatio: requireFiniteNumber(metrics['testCodeRatio'], `${code}_TEST_RATIO_INVALID`),
  };
};

const decodeAttestation = (value: unknown): ReleaseAttestation => {
  const record = requireUnknownRecord(value, 'RELEASE_ATTESTATION_INVALID');
  rejectExtraKeys(record, ['scheme', 'domain', 'envelope', 'envelopeHash', 'board', 'hanko', 'signerCount', 'verified'], 'RELEASE_ATTESTATION_EXTRA_FIELD');
  if (record['scheme'] !== 'xln-hanko-v1' || record['domain'] !== 'xln:foundation-release:v1' || record['verified'] !== true) throw new Error('RELEASE_ATTESTATION_LITERAL_INVALID');
  const envelope = requireUnknownRecord(record['envelope'], 'RELEASE_ENVELOPE_INVALID');
  rejectExtraKeys(envelope, ['version', 'sourceCommit', 'codeSnapshotRoot', 'frozenCoreRoot', 'generatedAt'], 'RELEASE_ENVELOPE_EXTRA_FIELD');
  const board = requireUnknownRecord(record['board'], 'RELEASE_BOARD_INVALID');
  rejectExtraKeys(board, ['schemaVersion', 'name', 'providerCompatibility', 'threshold', 'members', 'boardHash', 'entityId'], 'RELEASE_BOARD_EXTRA_FIELD');
  if (board['schemaVersion'] !== 1 || board['name'] !== 'xln Foundation' || board['providerCompatibility'] !== 'EntityProvider.HankoBytes.v1' || !Array.isArray(board['members'])) throw new Error('RELEASE_BOARD_LITERAL_INVALID');
  const members = board['members'].map((value) => {
    const member = requireUnknownRecord(value, 'RELEASE_BOARD_MEMBER_INVALID');
    rejectExtraKeys(member, ['label', 'address', 'weight'], 'RELEASE_BOARD_MEMBER_EXTRA_FIELD');
    return { label: requireString(member['label'], 'RELEASE_BOARD_MEMBER_LABEL_INVALID'), address: requireString(member['address'], 'RELEASE_BOARD_MEMBER_ADDRESS_INVALID'), weight: requireFiniteNumber(member['weight'], 'RELEASE_BOARD_MEMBER_WEIGHT_INVALID') };
  });
  return {
    scheme: record['scheme'], domain: record['domain'], envelope: {
      version: requireString(envelope['version'], 'RELEASE_ENVELOPE_VERSION_INVALID'), sourceCommit: requireString(envelope['sourceCommit'], 'RELEASE_ENVELOPE_COMMIT_INVALID'), codeSnapshotRoot: requireString(envelope['codeSnapshotRoot'], 'RELEASE_ENVELOPE_CODE_ROOT_INVALID'), frozenCoreRoot: requireString(envelope['frozenCoreRoot'], 'RELEASE_ENVELOPE_FROZEN_ROOT_INVALID'), generatedAt: requireString(envelope['generatedAt'], 'RELEASE_ENVELOPE_GENERATED_AT_INVALID'),
    }, envelopeHash: requireString(record['envelopeHash'], 'RELEASE_ENVELOPE_HASH_INVALID'), board: {
      schemaVersion: board['schemaVersion'], name: board['name'], providerCompatibility: board['providerCompatibility'], threshold: requireFiniteNumber(board['threshold'], 'RELEASE_BOARD_THRESHOLD_INVALID'), members, boardHash: requireString(board['boardHash'], 'RELEASE_BOARD_HASH_INVALID'), entityId: requireString(board['entityId'], 'RELEASE_BOARD_ENTITY_ID_INVALID'),
    }, hanko: requireString(record['hanko'], 'RELEASE_HANKO_INVALID'), signerCount: requireFiniteNumber(record['signerCount'], 'RELEASE_SIGNER_COUNT_INVALID'), verified: record['verified'],
  };
};

const decodeTree = (value: unknown): ReleaseSnapshotClaim['tree'] => {
  const record = requireUnknownRecord(value, 'RELEASE_TREE_INVALID');
  rejectExtraKeys(record, ['kind', 'name', 'path', 'category', 'metrics', 'delta', 'children'], 'RELEASE_TREE_EXTRA_FIELD');
  const children = record['children'];
  if (children !== undefined && !Array.isArray(children)) throw new Error('RELEASE_TREE_CHILDREN_INVALID');
  return { kind: requireString(record['kind'], 'RELEASE_TREE_KIND_INVALID'), path: requireString(record['path'], 'RELEASE_TREE_PATH_INVALID'), metrics: decodeMetricsRecord(record['metrics'], 'RELEASE_TREE_METRICS'), ...(children === undefined ? {} : { children: children.map(decodeTree) }) };
};

const decodeFrozenCoreRoot = (value: unknown, code: string): Readonly<{ rootHash: string }> => {
  const record = requireUnknownRecord(value, `${code}_INVALID`);
  rejectExtraKeys(record, ['schemaVersion', 'algorithm', 'status', 'rootHash', 'expectedRootHash', 'files', 'tree', 'mutableDependencies'], `${code}_EXTRA_FIELD`);
  return { rootHash: requireString(record['rootHash'], `${code}_ROOT_INVALID`) };
};

export const decodeReleaseSnapshot = (value: unknown): ReleaseSnapshotClaim => {
  const record = requireUnknownRecord(value, 'RELEASE_SNAPSHOT_INVALID');
  rejectExtraKeys(record, ['schemaVersion', 'toolVersion', 'collector', 'release', 'repository', 'tree', 'files', 'excluded', 'frozenCore', 'attestation'], 'RELEASE_SNAPSHOT_EXTRA_FIELD');
  if (record['schemaVersion'] !== 1) throw new Error('RELEASE_SNAPSHOT_SCHEMA_INVALID');
  const release = requireUnknownRecord(record['release'], 'RELEASE_SNAPSHOT_RELEASE_INVALID');
  rejectExtraKeys(release, ['version', 'sourceCommit', 'generatedAt', 'tag', 'previousVersion'], 'RELEASE_SNAPSHOT_RELEASE_EXTRA_FIELD');
  const repository = requireUnknownRecord(record['repository'], 'RELEASE_SNAPSHOT_REPOSITORY_INVALID');
  rejectExtraKeys(repository, ['name', 'merkleRoot', 'metrics', 'delta', 'changes', 'languages', 'categories', 'circularDependencies', 'longestDependencyChain', 'hotspots', 'largestFiles'], 'RELEASE_SNAPSHOT_REPOSITORY_EXTRA_FIELD');
  if (!Array.isArray(record['files'])) throw new Error('RELEASE_SNAPSHOT_FILES_INVALID');
  const files = record['files'].map((value) => {
    const file = requireUnknownRecord(value, 'RELEASE_FILE_INVALID');
    rejectExtraKeys(file, ['path', 'name', 'entryType', 'extension', 'language', 'category', 'sha256', 'metrics', 'complexityPerKloc', 'dependencies', 'dependents', 'testsFor', 'testedBy', 'delta'], 'RELEASE_FILE_EXTRA_FIELD');
    return { path: requireString(file['path'], 'RELEASE_FILE_PATH_INVALID'), sha256: requireString(file['sha256'], 'RELEASE_FILE_HASH_INVALID') };
  });
  const frozenCore = record['frozenCore'] === undefined ? undefined : decodeFrozenCoreRoot(record['frozenCore'], 'RELEASE_SNAPSHOT_FROZEN_CORE');
  return {
    release: { version: requireString(release['version'], 'RELEASE_SNAPSHOT_VERSION_INVALID'), sourceCommit: requireString(release['sourceCommit'], 'RELEASE_SNAPSHOT_COMMIT_INVALID'), generatedAt: requireString(release['generatedAt'], 'RELEASE_SNAPSHOT_GENERATED_AT_INVALID'), tag: requireString(release['tag'], 'RELEASE_SNAPSHOT_TAG_INVALID') },
    repository: { merkleRoot: repository['merkleRoot'] === null ? null : requireString(repository['merkleRoot'], 'RELEASE_SNAPSHOT_MERKLE_ROOT_INVALID'), metrics: decodeMetricsRecord(repository['metrics'], 'RELEASE_SNAPSHOT_METRICS') },
    tree: decodeTree(record['tree']), files,
    ...(frozenCore === undefined ? {} : { frozenCore }),
    ...(record['attestation'] === undefined ? {} : { attestation: decodeAttestation(record['attestation']) }),
  };
};

const decodeReleaseEntry = (value: unknown): ReleaseEntry => {
  const record = requireUnknownRecord(value, 'RELEASE_MANIFEST_ENTRY_INVALID');
  rejectExtraKeys(record, ['version', 'tag', 'generatedAt', 'markdown', 'snapshot', 'sourceCommit', 'metrics', 'modules', 'codeSnapshotRoot', 'frozenCore', 'attestation'], 'RELEASE_MANIFEST_ENTRY_EXTRA_FIELD');
  const modulesRecord = requireUnknownRecord(record['modules'], 'RELEASE_MANIFEST_MODULES_INVALID');
  const modules = Object.fromEntries(Object.entries(modulesRecord).map(([name, metrics]) => [name, decodeReleaseMetrics(metrics, `RELEASE_MANIFEST_MODULE_${name}`)]));
  const frozenCore = record['frozenCore'] === undefined ? undefined : decodeFrozenCoreRoot(record['frozenCore'], 'RELEASE_MANIFEST_FROZEN_CORE');
  return {
    version: requireString(record['version'], 'RELEASE_MANIFEST_VERSION_INVALID'), tag: requireString(record['tag'], 'RELEASE_MANIFEST_TAG_INVALID'), generatedAt: requireString(record['generatedAt'], 'RELEASE_MANIFEST_GENERATED_AT_INVALID'), markdown: requireString(record['markdown'], 'RELEASE_MANIFEST_MARKDOWN_INVALID'), snapshot: requireString(record['snapshot'], 'RELEASE_MANIFEST_SNAPSHOT_INVALID'), sourceCommit: requireString(record['sourceCommit'], 'RELEASE_MANIFEST_COMMIT_INVALID'), metrics: decodeReleaseMetrics(record['metrics'], 'RELEASE_MANIFEST_METRICS'), modules,
    ...(record['codeSnapshotRoot'] === undefined ? {} : { codeSnapshotRoot: requireString(record['codeSnapshotRoot'], 'RELEASE_MANIFEST_CODE_ROOT_INVALID') }),
    ...(frozenCore === undefined ? {} : { frozenCore }),
    ...(record['attestation'] === undefined ? {} : { attestation: decodeAttestation(record['attestation']) }),
  };
};

export const decodeReleaseManifest = (value: unknown): ReleaseManifest => {
  const record = requireUnknownRecord(value, 'RELEASE_MANIFEST_INVALID');
  rejectExtraKeys(record, ['schemaVersion', 'latest', 'releases'], 'RELEASE_MANIFEST_EXTRA_FIELD');
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['releases'])) throw new Error('RELEASE_MANIFEST_SCHEMA_INVALID');
  return { schemaVersion: record['schemaVersion'], latest: requireString(record['latest'], 'RELEASE_MANIFEST_LATEST_INVALID'), releases: record['releases'].map(decodeReleaseEntry) };
};

const verifySnapshot = async (release: ReleaseEntry, fetcher: typeof fetch): Promise<void> => {
  const response = await fetcher(release.snapshot, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Release snapshot request failed: ${response.status}`);
  const snapshot = decodeReleaseSnapshot(await readJsonUnknown(response));
  if (!verifyReleaseManifestSnapshotBinding(release, snapshot)) throw new Error(`INVALID FOUNDATION HANKO: release ${release.version}`);
};

export const fetchVerifiedReleaseManifest = async (fetcher: typeof fetch = fetch): Promise<ReleaseManifest> => {
  const response = await fetcher('/docs-catalog/releases/manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Release manifest request failed: ${response.status}`);
  const manifest = decodeReleaseManifest(await readJsonUnknown(response));
  if (!verifyReleaseManifestPolicy({ ...manifest, releases: [...manifest.releases] })) throw new Error('INVALID FOUNDATION HANKO: release manifest policy');
  const invalidRelease = manifest.releases.find((release) => !verifyReleaseManifestEntry(release));
  if (invalidRelease) throw new Error(`INVALID FOUNDATION HANKO: release ${invalidRelease.version}`);
  await Promise.all(manifest.releases.map((release) => verifySnapshot(release, fetcher)));
  return manifest;
};

export const fetchReleaseDocument = async (release: ReleaseEntry, fetcher: typeof fetch = fetch): Promise<string> => {
  const response = await fetcher(release.markdown, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Release document request failed: ${response.status}`);
  return sanitizeRenderedHtml(await marked.parse(await response.text(), { gfm: true }) as string);
};
