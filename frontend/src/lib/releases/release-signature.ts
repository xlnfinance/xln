import { ethers } from 'ethers';

export const RELEASE_SIGNATURE_DOMAIN = 'xln:foundation-release:v1';

const BOARD_ABI = ['tuple(uint16 votingThreshold,bytes32[] entityIds,uint16[] votingPowers,uint32 boardChangeDelay,uint32 controlChangeDelay,uint32 dividendChangeDelay)'];
const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];
const RELEASE_ENVELOPE_ABI = ['tuple(bytes32 domainHash,string version,string sourceCommit,bytes32 codeSnapshotRoot,bytes32 frozenCoreRoot,string generatedAt)'];

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

type DecodedClaim = readonly [string, readonly bigint[], readonly bigint[], bigint];
type DecodedHanko = readonly [readonly [readonly string[], string, readonly DecodedClaim[]]];

const addressEntityId = (address: string): string => ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();

// This compiled-in entity id is the trust anchor. Never default to attestation.board:
// an attacker can create a fresh 2-of-3 board and produce a perfectly valid self-signature.
// The release-integrity test asserts it stays synchronized with foundation-release-board.json.
export const FOUNDATION_RELEASE_BOARD_ENTITY_ID = '0xca0c2edf3058b14ab9e7ac05aacc8aaa636a79c2d688c86c68f66ffd75c634ea';
// The browser cannot discover a future release from an attacker replaying an old,
// valid manifest. It can and must reject anything older than the release it was
// built from. A release-integrity test keeps this floor equal to the root VERSION.
export const CURRENT_XLN_RELEASE_VERSION = '0.1.7';

export function computeFoundationBoardHash(threshold: number, members: FoundationReleaseMember[]): string {
  if (!Number.isInteger(threshold) || threshold <= 0 || threshold > 0xffff) throw new Error('RELEASE_BOARD_INVALID_THRESHOLD');
  if (!members.length) throw new Error('RELEASE_BOARD_EMPTY');
  const addresses = members.map((member) => addressEntityId(member.address));
  const weights = members.map((member) => {
    if (!Number.isInteger(member.weight) || member.weight <= 0 || member.weight > 0xffff) throw new Error(`RELEASE_BOARD_INVALID_WEIGHT:${member.label}`);
    return member.weight;
  });
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[threshold, addresses, weights, 0, 0, 0]])).toLowerCase();
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
  const minimum = [0, 1, 7];
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index]! !== minimum[index]!) return parts[index]! > minimum[index]!;
  }
  return true;
}

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

function packSignatures(signatures: ethers.Signature[]): string {
  const rs = signatures.flatMap((signature) => [ethers.getBytes(signature.r), ethers.getBytes(signature.s)]);
  const vBytes = new Uint8Array(Math.ceil(signatures.length / 8));
  signatures.forEach((signature, index) => {
    if (signature.yParity === 1) vBytes[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return ethers.hexlify(ethers.concat([...rs, vBytes]));
}

function unpackSignatures(packed: string): ethers.Signature[] {
  const bytes = ethers.getBytes(packed);
  let count = 0;
  for (let candidate = 1; candidate <= 16000; candidate += 1) {
    const expected = candidate * 64 + Math.ceil(candidate / 8);
    if (expected === bytes.length) { count = candidate; break; }
    if (expected > bytes.length) break;
  }
  if (!count) throw new Error('RELEASE_HANKO_INVALID_PACKED_SIGNATURE_LENGTH');
  const vOffset = count * 64;
  return Array.from({ length: count }, (_, index) => {
    const r = ethers.hexlify(bytes.slice(index * 64, index * 64 + 32));
    const s = ethers.hexlify(bytes.slice(index * 64 + 32, index * 64 + 64));
    const yParity = ((bytes[vOffset + Math.floor(index / 8)]! >> (index % 8)) & 1) as 0 | 1;
    return ethers.Signature.from({ r, s, yParity });
  });
}

export function buildReleaseHanko(envelopeHash: string, board: FoundationReleaseBoard, privateKeys: string[]): { hanko: string; signerCount: number } {
  const byAddress = new Map(privateKeys.map((privateKey) => {
    const key = new ethers.SigningKey(privateKey);
    return [ethers.computeAddress(key.publicKey).toLowerCase(), key] as const;
  }));
  const signers = board.members.filter((member) => byAddress.has(member.address.toLowerCase())).slice(0, board.threshold);
  if (signers.reduce((sum, member) => sum + member.weight, 0) < board.threshold) throw new Error('RELEASE_HANKO_INSUFFICIENT_KEYS');
  const nonSigners = board.members.filter((member) => !signers.includes(member));
  const signatures = signers.map((member) => byAddress.get(member.address.toLowerCase())!.sign(envelopeHash));
  const placeholders = nonSigners.map((member) => addressEntityId(member.address));
  const signerIndexes = new Map(signers.map((member, index) => [member.address.toLowerCase(), placeholders.length + index]));
  const placeholderIndexes = new Map(nonSigners.map((member, index) => [member.address.toLowerCase(), index]));
  const entityIndexes = board.members.map((member) => signerIndexes.get(member.address.toLowerCase()) ?? placeholderIndexes.get(member.address.toLowerCase())!);
  const hanko = ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    placeholders,
    packSignatures(signatures),
    [[board.entityId, entityIndexes, board.members.map((member) => member.weight), board.threshold]],
  ]]);
  return { hanko, signerCount: signatures.length };
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
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(HANKO_ABI, attestation.hanko) as unknown as DecodedHanko;
    const [placeholdersRaw, packed, claims] = decoded[0];
    if (claims.length !== 1) return false;
    const [entityId, indexesRaw, weightsRaw, thresholdRaw] = claims[0]!;
    const signatures = unpackSignatures(packed);
    if (signatures.length !== attestation.signerCount) return false;
    const recovered = signatures.map((signature) => ethers.recoverAddress(attestation.envelopeHash, signature).toLowerCase());
    const placeholders = placeholdersRaw.map((value) => value.toLowerCase());
    const indexes = indexesRaw.map(Number);
    const weights = weightsRaw.map(Number);
    const threshold = Number(thresholdRaw);
    if (entityId.toLowerCase() !== boardHash || threshold !== attestation.board.threshold) return false;
    if (indexes.length !== attestation.board.members.length || weights.length !== indexes.length) return false;
    let eoaWeight = 0;
    const reconstructed = indexes.map((index, boardIndex) => {
      if (index < placeholders.length) return placeholders[index]!;
      const signerIndex = index - placeholders.length;
      const signer = recovered[signerIndex];
      if (!signer) throw new Error('RELEASE_HANKO_INDEX_OUT_OF_BOUNDS');
      eoaWeight += weights[boardIndex]!;
      return addressEntityId(signer);
    });
    const expectedEntities = attestation.board.members.map((member) => addressEntityId(member.address));
    return reconstructed.every((value, index) => value === expectedEntities[index]) &&
      weights.every((value, index) => value === attestation.board.members[index]!.weight) &&
      eoaWeight >= threshold;
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
    // 0.1.5/0.1.6 predate Foundation Hanko. Every release from 0.1.7 onward fails closed.
    if (!snapshot.attestation) return !requiresFoundationAttestation(snapshot.release.version);
    if (!snapshot.frozenCore || !verifyReleaseAttestation(snapshot.attestation, expectedBoard)) return false;
    if (typeof snapshot.repository.merkleRoot !== 'string') return false;
    const computedRoot = computeCodeSnapshotRoot(snapshot.files);
    if (computedRoot !== snapshot.repository.merkleRoot.toLowerCase()) return false;
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
    if (!entry.attestation) return !requiresFoundationAttestation(entry.version);
    if (!entry.codeSnapshotRoot || !entry.frozenCore || !verifyReleaseAttestation(entry.attestation, expectedBoard)) return false;
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
    if (!manifest.releases.some((release) => requiresFoundationAttestation(release.version) && release.attestation)) return false;
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
