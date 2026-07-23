import { ethers } from 'ethers';
import { asHankoBytes32, encodeSignedHanko } from '../../../../runtime/hanko/codec';
import {
  hashHankoBoardClaim,
  resolveHankoBoardDelays,
  verifyCanonicalHanko,
} from '../../../../runtime/hanko/claims';
import type { HankoHex } from '../../../../runtime/types/hanko';

export const RELEASE_SIGNATURE_DOMAIN = 'xln:foundation-release:v1';

const RELEASE_ENVELOPE_ABI = ['tuple(bytes32 domainHash,string version,string sourceCommit,bytes32 codeSnapshotRoot,bytes32 frozenCoreRoot,string generatedAt)'];
const HANKO_BOARD_DELAYS = resolveHankoBoardDelays();

export type FoundationReleaseMember = {
  label: string;
  address: string;
  weight: number;
};

export type FoundationReleaseBoard = {
  schemaVersion: 1;
  name: 'xln Foundation';
  providerCompatibility: 'EntityProvider.HankoBytes.v1';
  threshold: number;
  members: FoundationReleaseMember[];
  boardHash: string;
  entityId: string;
};

export type ReleaseEnvelope = {
  version: string;
  sourceCommit: string;
  codeSnapshotRoot: string;
  frozenCoreRoot: string;
  generatedAt: string;
};

export type ReleaseAttestation = {
  scheme: 'xln-hanko-v1';
  domain: typeof RELEASE_SIGNATURE_DOMAIN;
  envelope: ReleaseEnvelope;
  envelopeHash: string;
  board: FoundationReleaseBoard;
  hanko: string;
  signerCount: number;
  verified: true;
};

export type ReleaseFileClaim = {
  path: string;
  sha256: string;
};

type ReleaseMetricsClaim = object;

type ReleaseTreeClaim = {
  kind: string;
  path: string;
  metrics: ReleaseMetricsClaim;
  children?: ReleaseTreeClaim[];
};

export type ReleaseSnapshotClaim = {
  release: Pick<ReleaseEnvelope, 'version' | 'sourceCommit' | 'generatedAt'> & { tag: string };
  repository: { merkleRoot: string | null; metrics: ReleaseMetricsClaim };
  tree: ReleaseTreeClaim;
  files: ReleaseFileClaim[];
  frozenCore?: { rootHash: string };
  attestation?: ReleaseAttestation;
};

export type ReleaseManifestClaim = {
  version: string;
  tag: string;
  generatedAt: string;
  markdown: string;
  snapshot: string;
  sourceCommit: string;
  metrics: ReleaseMetricsClaim;
  modules: Record<string, ReleaseMetricsClaim>;
  codeSnapshotRoot?: string;
  frozenCore?: { rootHash: string };
  attestation?: ReleaseAttestation;
};

export type ReleaseManifestPolicyClaim = {
  schemaVersion: number;
  latest: string;
  releases: ReleaseManifestClaim[];
};

const addressEntityId = (address: string): HankoHex => asHankoBytes32(
  ethers.zeroPadValue(ethers.getAddress(address), 32),
  'RELEASE_MEMBER_ENTITY_ID',
);

// This compiled-in entity id is the trust anchor. Never default to attestation.board:
// an attacker can create a fresh 2-of-3 board and produce a perfectly valid self-signature.
// The release-integrity test asserts it stays synchronized with foundation-release-board.json.
export const FOUNDATION_RELEASE_BOARD_ENTITY_ID = '0xca0c2edf3058b14ab9e7ac05aacc8aaa636a79c2d688c86c68f66ffd75c634ea';
// The browser cannot discover a future release from an attacker replaying an old,
// valid manifest. It can and must reject anything older than the release it was
// built from. A release-integrity test keeps this floor equal to the root VERSION.
export const CURRENT_XLN_RELEASE_VERSION = '0.1.19';

export function computeFoundationBoardHash(threshold: number, members: FoundationReleaseMember[]): HankoHex {
  if (!Number.isInteger(threshold) || threshold <= 0 || threshold > 0xffff) throw new Error('RELEASE_BOARD_INVALID_THRESHOLD');
  if (!members.length) throw new Error('RELEASE_BOARD_EMPTY');
  const addresses = members.map((member) => addressEntityId(member.address));
  const weights = members.map((member) => {
    if (!Number.isInteger(member.weight) || member.weight <= 0 || member.weight > 0xffff) throw new Error(`RELEASE_BOARD_INVALID_WEIGHT:${member.label}`);
    return member.weight;
  });
  return hashHankoBoardClaim({
    entityId: asHankoBytes32(ethers.ZeroHash, 'RELEASE_LAZY_ENTITY_ID'),
    members: addresses.map((entityId, index) => ({
      entityId,
      weight: BigInt(weights[index]!),
    })),
    threshold: BigInt(threshold),
    delays: HANKO_BOARD_DELAYS,
  });
}

export function createFoundationReleaseBoard(addresses: string[], threshold = 2): FoundationReleaseBoard {
  const members = addresses.map((address, index) => ({ label: `Foundation signer ${String.fromCharCode(65 + index)}`, address: ethers.getAddress(address), weight: 1 }));
  const boardHash = computeFoundationBoardHash(threshold, members);
  return {
    schemaVersion: 1,
    name: 'xln Foundation',
    providerCompatibility: 'EntityProvider.HankoBytes.v1',
    threshold,
    members,
    boardHash,
    entityId: boardHash,
  };
}

export function computeReleaseEnvelopeHash(envelope: ReleaseEnvelope): string {
  const domainHash = ethers.keccak256(ethers.toUtf8Bytes(RELEASE_SIGNATURE_DOMAIN));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(RELEASE_ENVELOPE_ABI, [[
    domainHash,
    envelope.version,
    envelope.sourceCommit,
    envelope.codeSnapshotRoot,
    envelope.frozenCoreRoot,
    envelope.generatedAt,
  ]]);
  return ethers.keccak256(encoded).toLowerCase();
}

export function computeCodeSnapshotRoot(files: ReleaseFileClaim[]): string {
  // Rebuild the collector's root from every file claim. Trusting repository.merkleRoot
  // directly would let an attacker alter file hashes while retaining the signed outer root.
  const chunks: Uint8Array[] = [ethers.toUtf8Bytes('xln:code-snapshot:v1\0')];
  const paths = new Set<string>();
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    if (!file.path || file.path.includes('\0') || paths.has(file.path) || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      throw new Error(`RELEASE_FILE_CLAIM_INVALID:${file.path}`);
    }
    paths.add(file.path);
    chunks.push(ethers.toUtf8Bytes(file.path), new Uint8Array([0]), ethers.getBytes(`0x${file.sha256}`));
  }
  return ethers.sha256(ethers.concat(chunks)).toLowerCase();
}

function semverParts(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareReleaseVersions(left: string, right: string): number {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (!leftParts || !rightParts) throw new Error('RELEASE_VERSION_INVALID');
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) return leftParts[index]! - rightParts[index]!;
  }
  return 0;
}

function hasCanonicalSnapshotIdentity(snapshot: ReleaseSnapshotClaim): boolean {
  return Boolean(semverParts(snapshot.release.version)) &&
    snapshot.release.tag === `v${snapshot.release.version}`;
}

function hasCanonicalManifestIdentity(entry: ReleaseManifestClaim): boolean {
  if (!semverParts(entry.version)) return false;
  return entry.tag === `v${entry.version}` &&
    entry.markdown === `/docs-catalog/releases/${entry.version}.md` &&
    entry.snapshot === `/docs-catalog/releases/data/${entry.version}.json`;
}

function metricEntries(value: ReleaseMetricsClaim): Array<[string, number]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([, metric]) => typeof metric !== 'number' || !Number.isFinite(metric))) return null;
  return entries.sort(([left], [right]) => left.localeCompare(right)) as Array<[string, number]>;
}

function metricsEqual(left: ReleaseMetricsClaim, right: ReleaseMetricsClaim): boolean {
  const leftEntries = metricEntries(left);
  const rightEntries = metricEntries(right);
  if (!leftEntries || !rightEntries || leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const counterpart = rightEntries[index];
    return counterpart?.[0] === key && Object.is(counterpart[1], value);
  });
}

function snapshotModules(snapshot: ReleaseSnapshotClaim): Record<string, ReleaseMetricsClaim> | null {
  if (!snapshot.tree || !Array.isArray(snapshot.tree.children)) return null;
  const modules: Record<string, ReleaseMetricsClaim> = {};
  for (const node of snapshot.tree.children) {
    if (node.kind !== 'directory') continue;
    if (!node.path || node.path in modules || !metricEntries(node.metrics)) return null;
    modules[node.path] = node.metrics;
  }
  return modules;
}

function modulesEqual(left: Record<string, ReleaseMetricsClaim>, right: Record<string, ReleaseMetricsClaim>): boolean {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && metricsEqual(left[name]!, right[name]!));
}

export function requiresFoundationAttestation(version: string): boolean {
  const parts = semverParts(version);
  if (!parts) return true;
  const minimum = [0, 1, 9];
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index]! !== minimum[index]!) return parts[index]! > minimum[index]!;
  }
  return true;
}

const hasHistoricalHankoRecord = (version: string): boolean => {
  const parts = semverParts(version);
  if (!parts) return false;
  return compareReleaseVersions(version, '0.1.7') >= 0 &&
    compareReleaseVersions(version, '0.1.9') < 0;
};

function trustedBoardHash(expectedBoard: FoundationReleaseBoard | string): string {
  if (typeof expectedBoard === 'string') {
    if (!ethers.isHexString(expectedBoard, 32)) throw new Error('RELEASE_TRUSTED_BOARD_INVALID');
    return expectedBoard.toLowerCase();
  }
  const computed = computeFoundationBoardHash(expectedBoard.threshold, expectedBoard.members);
  if (computed !== expectedBoard.boardHash.toLowerCase() || computed !== expectedBoard.entityId.toLowerCase()) {
    throw new Error('RELEASE_TRUSTED_BOARD_INVALID');
  }
  return computed;
}

export function isCanonicalFoundationBoard(board: FoundationReleaseBoard): boolean {
  try {
    return trustedBoardHash(board) === FOUNDATION_RELEASE_BOARD_ENTITY_ID;
  } catch {
    return false;
  }
}

export function buildReleaseHanko(envelopeHash: string, board: FoundationReleaseBoard, privateKeys: string[]): { hanko: string; signerCount: number } {
  const byAddress = new Map(privateKeys.map((privateKey) => {
    const address = ethers.computeAddress(new ethers.SigningKey(privateKey).publicKey).toLowerCase();
    return [address, privateKey] as const;
  }));
  const signers: FoundationReleaseMember[] = [];
  let signedPower = 0;
  for (const member of board.members) {
    if (signedPower >= board.threshold) break;
    if (!byAddress.has(member.address.toLowerCase())) continue;
    signers.push(member);
    signedPower += member.weight;
  }
  if (signedPower < board.threshold) throw new Error('RELEASE_HANKO_INSUFFICIENT_KEYS');
  const nonSigners = board.members.filter((member) => !signers.includes(member));
  const placeholders = nonSigners.map((member) => addressEntityId(member.address));
  const signerIndexes = new Map(signers.map((member, index) => [member.address.toLowerCase(), placeholders.length + index]));
  const placeholderIndexes = new Map(nonSigners.map((member, index) => [member.address.toLowerCase(), index]));
  const entityIndexes = board.members.map((member) => signerIndexes.get(member.address.toLowerCase()) ?? placeholderIndexes.get(member.address.toLowerCase())!);
  const hanko = encodeSignedHanko({
    digest: envelopeHash,
    privateKeys: signers.map((member) => ethers.getBytes(byAddress.get(member.address.toLowerCase())!)),
    placeholders,
    claims: [{
      entityId: asHankoBytes32(board.entityId, 'RELEASE_BOARD_ENTITY_ID'),
      entityIndexes: entityIndexes.map((index) => BigInt(index)),
      weights: board.members.map((member) => BigInt(member.weight)),
      threshold: BigInt(board.threshold),
      ...HANKO_BOARD_DELAYS,
    }],
  });
  return { hanko, signerCount: signers.length };
}

export function verifyReleaseAttestation(
  attestation: ReleaseAttestation,
  expectedBoard: FoundationReleaseBoard | string = FOUNDATION_RELEASE_BOARD_ENTITY_ID,
): boolean {
  try {
    if (attestation.scheme !== 'xln-hanko-v1' || attestation.domain !== RELEASE_SIGNATURE_DOMAIN) return false;
    if (computeReleaseEnvelopeHash(attestation.envelope) !== attestation.envelopeHash.toLowerCase()) return false;
    const expectedBoardHash = trustedBoardHash(expectedBoard);
    const boardHash = computeFoundationBoardHash(attestation.board.threshold, attestation.board.members);
    if (boardHash !== expectedBoardHash || boardHash !== attestation.board.boardHash.toLowerCase() || boardHash !== attestation.board.entityId.toLowerCase()) return false;
    if (attestation.board.providerCompatibility !== 'EntityProvider.HankoBytes.v1') return false;
    const verified = verifyCanonicalHanko({
      digest: attestation.envelopeHash,
      hanko: attestation.hanko,
      expectedTargetEntityId: boardHash,
    });
    if (verified.signatures.length !== attestation.signerCount || verified.claims.length !== 1) return false;
    const claim = verified.claims[0]!;
    const expectedEntities = attestation.board.members.map((member) => addressEntityId(member.address));
    return claim.members.length === expectedEntities.length &&
      claim.members.every((member, index) => (
        member.entityId === expectedEntities[index] &&
        member.weight === BigInt(attestation.board.members[index]!.weight)
      )) && claim.threshold === BigInt(attestation.board.threshold) &&
      Object.values(claim.delays).every((delay) => delay === 0n);
  } catch {
    return false;
  }
}

function envelopeMatches(
  attestation: ReleaseAttestation,
  claim: Pick<ReleaseEnvelope, 'version' | 'sourceCommit' | 'generatedAt'> & { codeSnapshotRoot: string; frozenCoreRoot: string },
): boolean {
  const envelope = attestation.envelope;
  return envelope.version === claim.version &&
    envelope.sourceCommit === claim.sourceCommit &&
    envelope.generatedAt === claim.generatedAt &&
    envelope.codeSnapshotRoot.toLowerCase() === claim.codeSnapshotRoot.toLowerCase() &&
    envelope.frozenCoreRoot.toLowerCase() === claim.frozenCoreRoot.toLowerCase();
}

export function verifyReleaseSnapshot(
  snapshot: ReleaseSnapshotClaim,
  expectedBoard: FoundationReleaseBoard | string = FOUNDATION_RELEASE_BOARD_ENTITY_ID,
): boolean {
  try {
    if (!hasCanonicalSnapshotIdentity(snapshot) ||
      !metricsEqual(snapshot.repository.metrics, snapshot.tree.metrics) ||
      !snapshotModules(snapshot)) return false;
    if (!requiresFoundationAttestation(snapshot.release.version) &&
      !hasHistoricalHankoRecord(snapshot.release.version)) return true;
    if (typeof snapshot.repository.merkleRoot !== 'string') return false;
    const computedRoot = computeCodeSnapshotRoot(snapshot.files);
    if (computedRoot !== snapshot.repository.merkleRoot.toLowerCase()) return false;
    // Historical attestations remain immutable catalog evidence, but their
    // pre-canonical wire format is never treated as current authorization.
    if (!requiresFoundationAttestation(snapshot.release.version)) {
      return Boolean(snapshot.attestation && snapshot.frozenCore && envelopeMatches(snapshot.attestation, {
        ...snapshot.release,
        codeSnapshotRoot: computedRoot,
        frozenCoreRoot: snapshot.frozenCore.rootHash,
      }));
    }
    if (!snapshot.attestation || !snapshot.frozenCore ||
      !verifyReleaseAttestation(snapshot.attestation, expectedBoard)) return false;
    return envelopeMatches(snapshot.attestation, {
      ...snapshot.release,
      codeSnapshotRoot: computedRoot,
      frozenCoreRoot: snapshot.frozenCore.rootHash,
    });
  } catch {
    return false;
  }
}

export function verifyReleaseManifestEntry(
  entry: ReleaseManifestClaim,
  expectedBoard: FoundationReleaseBoard | string = FOUNDATION_RELEASE_BOARD_ENTITY_ID,
): boolean {
  try {
    if (!hasCanonicalManifestIdentity(entry) || !metricEntries(entry.metrics)) return false;
    if (!entry.modules || Object.values(entry.modules).some((metrics) => !metricEntries(metrics))) return false;
    if (!requiresFoundationAttestation(entry.version)) {
      if (!hasHistoricalHankoRecord(entry.version)) return true;
      return Boolean(entry.attestation && entry.codeSnapshotRoot && entry.frozenCore && envelopeMatches(entry.attestation, {
        version: entry.version,
        sourceCommit: entry.sourceCommit,
        generatedAt: entry.generatedAt,
        codeSnapshotRoot: entry.codeSnapshotRoot,
        frozenCoreRoot: entry.frozenCore.rootHash,
      }));
    }
    if (!entry.attestation || !entry.codeSnapshotRoot || !entry.frozenCore ||
      !verifyReleaseAttestation(entry.attestation, expectedBoard)) return false;
    return envelopeMatches(entry.attestation, {
      version: entry.version,
      sourceCommit: entry.sourceCommit,
      generatedAt: entry.generatedAt,
      codeSnapshotRoot: entry.codeSnapshotRoot,
      frozenCoreRoot: entry.frozenCore.rootHash,
    });
  } catch {
    return false;
  }
}

export function verifyReleaseManifestPolicy(
  manifest: ReleaseManifestPolicyClaim,
  expectedBoard: FoundationReleaseBoard | string = FOUNDATION_RELEASE_BOARD_ENTITY_ID,
  minimumLatest: string = CURRENT_XLN_RELEASE_VERSION,
): boolean {
  try {
    if (manifest.schemaVersion !== 1 || !manifest.releases.length) return false;
    const versions = manifest.releases.map((release) => release.version);
    if (new Set(versions).size !== versions.length) return false;
    const highest = [...versions].sort(compareReleaseVersions).at(-1);
    if (!highest || highest !== manifest.latest) return false;
    if (compareReleaseVersions(manifest.latest, minimumLatest) < 0) return false;
    const v2Releases = manifest.releases.filter((release) => requiresFoundationAttestation(release.version));
    if (v2Releases.length > 0 && v2Releases.some((release) => !release.attestation)) return false;
    return manifest.releases.every((release) => verifyReleaseManifestEntry(release, expectedBoard));
  } catch {
    return false;
  }
}

export function verifyReleaseManifestSnapshotBinding(
  entry: ReleaseManifestClaim,
  snapshot: ReleaseSnapshotClaim,
  expectedBoard: FoundationReleaseBoard | string = FOUNDATION_RELEASE_BOARD_ENTITY_ID,
): boolean {
  if (!verifyReleaseManifestEntry(entry, expectedBoard) || !verifyReleaseSnapshot(snapshot, expectedBoard)) return false;
  const modules = snapshotModules(snapshot);
  if (!modules ||
    entry.version !== snapshot.release.version ||
    entry.tag !== snapshot.release.tag ||
    entry.generatedAt !== snapshot.release.generatedAt ||
    entry.sourceCommit !== snapshot.release.sourceCommit ||
    !metricsEqual(entry.metrics, snapshot.repository.metrics) ||
    !modulesEqual(entry.modules, modules)) return false;
  const entryAttestation = entry.attestation;
  const snapshotAttestation = snapshot.attestation;
  if (!entryAttestation && !snapshotAttestation) {
    return true;
  }
  return Boolean(entryAttestation && snapshotAttestation &&
    entryAttestation.envelopeHash.toLowerCase() === snapshotAttestation.envelopeHash.toLowerCase());
}

export function signReleaseEnvelope(envelope: ReleaseEnvelope, board: FoundationReleaseBoard, privateKeys: string[]): ReleaseAttestation {
  const envelopeHash = computeReleaseEnvelopeHash(envelope);
  const { hanko, signerCount } = buildReleaseHanko(envelopeHash, board, privateKeys);
  const attestation: ReleaseAttestation = {
    scheme: 'xln-hanko-v1',
    domain: RELEASE_SIGNATURE_DOMAIN,
    envelope,
    envelopeHash,
    board,
    hanko,
    signerCount,
    verified: true,
  };
  if (!verifyReleaseAttestation(attestation, board)) throw new Error('RELEASE_HANKO_SELF_VERIFICATION_FAILED');
  return attestation;
}
