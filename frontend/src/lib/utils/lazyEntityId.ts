import { AbiCoder, getAddress, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers';

type LazyValidator = string | { name: string; weight: number };

const compareStableText = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

const resolveValidatorAddress = (validator: string): string => {
	const raw = String(validator || '').trim();
	if (raw.startsWith('0x') && raw.length === 42) return getAddress(raw);
	if (raw.startsWith('0x') && raw.length === 66) return getAddress(`0x${raw.slice(-40)}`);
	throw new Error(`Cannot derive lazy entity id for non-address validator ${validator}`);
};

const toBoardEntityId = (validator: string): string =>
	zeroPadValue(resolveValidatorAddress(validator), 32);

const toUint16 = (value: bigint, label: string): number => {
	if (value < 0n || value > 0xffffn) {
		throw new Error(`Board ${label} out of range: ${value.toString()}`);
	}
	return Number(value);
};

const encodeBoard = (validators: string[], shares: Record<string, bigint>, threshold: bigint): string => {
	const entityIds = validators.map(toBoardEntityId);
	const votingPowers = validators.map((validator) => toUint16(shares[validator] || 1n, `weight(${validator})`));
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

	const sortedValidators = validatorData.slice().sort((left, right) =>
		compareStableText(resolveValidatorAddress(left.name), resolveValidatorAddress(right.name)));
	const shares: Record<string, bigint> = {};
	const validatorIds = sortedValidators.map((validator) => {
		shares[validator.name] = validator.weight;
		return validator.name;
	});
	const encodedBoard = encodeBoard(validatorIds, shares, threshold);
	return encodedBoard.startsWith('0x') ? keccak256(encodedBoard) : keccak256(toUtf8Bytes(encodedBoard));
};
