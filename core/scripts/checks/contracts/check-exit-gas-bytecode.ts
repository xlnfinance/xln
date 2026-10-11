import { keccak256 } from 'ethers';
import { STACK_ARTIFACTS } from '../../../jurisdiction/adapter/stack-manager/verification';
import { safeStringify } from '../../../protocol/serialization';

const root = new URL('../../../../jurisdictions/', import.meta.url);
type LinkSlot = { source: string; library: string; start: number; length: number };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXIT_GAS_ARTIFACT_INVALID');
  return value as Record<string, unknown>;
};

const linkSlots = (value: unknown): LinkSlot[] =>
  Object.entries(record(value))
    .flatMap(([source, libraries]) =>
      Object.entries(record(libraries)).flatMap(([library, references]) => {
        if (!Array.isArray(references)) throw new Error('EXIT_GAS_LINK_REFERENCES_INVALID');
        return references.map(raw => {
          const { start, length } = record(raw);
          if (!Number.isSafeInteger(start) || Number(start) < 0 || length !== 20) {
            throw new Error('EXIT_GAS_LINK_SLOT_INVALID');
          }
          return { source: source.replace(/^project\//, ''), library, start: Number(start), length };
        });
      }),
    )
    .sort((a, b) => a.start - b.start);

/** Only compiler-declared link slots may differ between build tools. */
const bindLinks = (value: unknown, slots: LinkSlot[]): string => {
  if (typeof value !== 'string' || !value.startsWith('0x')) throw new Error('EXIT_GAS_BYTECODE_INVALID');
  let bytecode = value.toLowerCase();
  let end = 0;
  for (const slot of slots) {
    const start = 2 + slot.start * 2;
    const nextEnd = start + slot.length * 2;
    if (start < end || nextEnd > bytecode.length) throw new Error('EXIT_GAS_LINK_BOUNDS_INVALID');
    bytecode = bytecode.slice(0, start) + '0'.repeat(slot.length * 2) + bytecode.slice(nextEnd);
    end = nextEnd;
  }
  if (!/^0x(?:[0-9a-f]{2})+$/.test(bytecode)) throw new Error('EXIT_GAS_BYTECODE_UNRESOLVED');
  return bytecode;
};

for (const descriptor of Object.values(STACK_ARTIFACTS)) {
  const hardhat = record(await Bun.file(new URL(`artifacts/${descriptor.path}`, root)).json());
  const filename = descriptor.sourceName.split('/').at(-1);
  const foundry = record(await Bun.file(new URL(`forge-out/${filename}/${descriptor.contractName}.json`, root)).json());
  const deployed = record(foundry['deployedBytecode']);
  const productionLinks = linkSlots(hardhat['deployedLinkReferences']);
  const measuredLinks = linkSlots(deployed['linkReferences']);
  if (safeStringify(productionLinks) !== safeStringify(measuredLinks)) {
    throw new Error(`EXIT_GAS_LIBRARY_BINDING_MISMATCH:${descriptor.contractName}`);
  }
  const production = bindLinks(hardhat['deployedBytecode'], productionLinks);
  const measured = bindLinks(deployed['object'], measuredLinks);
  if (production !== measured) throw new Error(`EXIT_GAS_PRODUCTION_BYTECODE_MISMATCH:${descriptor.contractName}`);
  console.log(
    safeStringify({
      contract: descriptor.contractName,
      bytes: (production.length - 2) / 2,
      linkedTemplateKeccak256: keccak256(production),
      librarySlots: productionLinks.length,
    }),
  );
}
console.log('EXIT_GAS_PRODUCTION_BYTECODE_OK contracts=8');
