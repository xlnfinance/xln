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

type DecodedClaim = readonly [string, readonly bigint[], readonly bigint[], bigint];
type DecodedHanko = readonly [readonly [readonly string[], string, readonly DecodedClaim[]]];

const addressEntityId = (address: string): string => ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();

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

export function verifyReleaseAttestation(attestation: ReleaseAttestation): boolean {
  try {
    if (attestation.scheme !== 'xln-hanko-v1' || attestation.domain !== RELEASE_SIGNATURE_DOMAIN) return false;
    if (computeReleaseEnvelopeHash(attestation.envelope) !== attestation.envelopeHash.toLowerCase()) return false;
    const boardHash = computeFoundationBoardHash(attestation.board.threshold, attestation.board.members);
    if (boardHash !== attestation.board.boardHash.toLowerCase() || boardHash !== attestation.board.entityId.toLowerCase()) return false;
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
  if (!verifyReleaseAttestation(attestation)) throw new Error('RELEASE_HANKO_SELF_VERIFICATION_FAILED');
  return attestation;
}
