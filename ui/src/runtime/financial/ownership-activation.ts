export type TakeoverStatus = {
	targetEntityId: string;
	currentBoardHash: string;
	proposedBoardHash: string;
	currentUnix: bigint;
	activateAt: bigint;
};

/** EntityProvider.activateBoard compares its deadline with block.timestamp, in seconds. */
export function takeoverActivationReady(status: TakeoverStatus | null): boolean {
	return status !== null && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(status.proposedBoardHash)
		&& status.activateAt > 0n && status.currentUnix >= status.activateAt;
}
