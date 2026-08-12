import { AbiCoder, getAddress, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers';

type LazyValidator = string | { name: string; weight: number };

const toBoardEntityId = (validator: string): string => {
	const raw = String(validator || '').trim();
	if (raw.startsWith('0x') && raw.length === 42) return zeroPadValue(getAddress(raw), 32);
	if (/^0x[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
	throw new Error(`Cannot derive lazy entity id for non-address validator ${validator}`);
};

const toUint16 = (value: bigint, label: string): number => {
	if (value < 0n || value > 0xffffn) {
		throw new Error(`Board ${label} out of range: ${value.toString()}`);
	}
	return Number(value);
};

const encodeBoard = (validators: string[], shares: Record<string, bigint>, threshold: bigint): string => {
	const entityIds = validators.map(toBoardEntityId);
	const votingPowers = validators.map((validator) => {
		const weight = shares[validator];
		if (weight === undefined) throw new Error(`Board voting power missing: ${validator}`);
		return toUint16(weight, `weight(${validator})`);
	});
	return AbiCoder.defaultAbiCoder().encode(
		['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
		[[toUint16(threshold, 'threshold'), entityIds, votingPowers, 0, 0, 0]],
	);
};

export const generateLazyEntityIdPreview = (
	validators: LazyValidator[],
	threshold: bigint,
): string => {
	const validatorData = validators.map((validator) =>
		typeof validator === 'string'
			? { name: validator, weight: 1n }
			: { name: validator.name, weight: BigInt(validator.weight) });

	const shares: Record<string, bigint> = {};
	const validatorIds = validatorData.map((validator) => {
		shares[validator.name] = validator.weight;
		return validator.name;
	});
	const encodedBoard = encodeBoard(validatorIds, shares, threshold);
	return encodedBoard.startsWith('0x') ? keccak256(encodedBoard) : keccak256(toUtf8Bytes(encodedBoard));
};
