/**
 * What makes this wallet sovereign, as facts the runtime can prove: where the
 * keys are, which frames both sides signed, what a counterparty could walk
 * away with, and how long each side has to answer a dispute. Everything here
 * is read from the account documents.
 */
import type { AccountView } from '../views';
import { usdOf } from './prices';

export type AccountSafety = {
	counterpartyId: string;
	label: string;
	isHub: boolean;
	frameHeight: number;
	/** Both hankos on the latest frame: the state is enforceable as is. */
	frameCosigned: boolean;
	/** Their dispute-proof hanko is on file: we can go on-chain without asking them. */
	canDisputeAlone: boolean;
	/** Seconds each side gets to answer on-chain, from the signed account config. */
	ourResponseSeconds: number;
	theirResponseSeconds: number;
	/** USD they owe us with nothing on-chain behind it. */
	riskUsd: number;
	/** USD they owe us that collateral covers. */
	securedUsd: number;
	/** USD we owe them. */
	owedUsd: number;
	/** Active on-chain dispute deadline (unix seconds) or 0. */
	disputeTimeout: number;
	disputePhase: AccountView['dispute'];
};

export function accountSafety(account: AccountView): AccountSafety {
	const doc = account.doc;
	const config = doc.state?.disputeConfig;
	const left = Number(config?.leftResponseSeconds ?? 0);
	const right = Number(config?.rightResponseSeconds ?? 0);
	let riskUsd = 0;
	let securedUsd = 0;
	let owedUsd = 0;
	for (const token of account.tokens) {
		if (token.signed > 0n) {
			const unsecured = token.derived.outPeerCredit < token.signed ? token.derived.outPeerCredit : token.signed;
			riskUsd += usdOf(token.tokenId, unsecured);
			securedUsd += usdOf(token.tokenId, token.signed - unsecured);
		} else if (token.signed < 0n) owedUsd += usdOf(token.tokenId, -token.signed);
	}
	return {
		counterpartyId: account.counterpartyId,
		label: account.label,
		isHub: account.isHub,
		frameHeight: account.frameHeight,
		frameCosigned: Boolean(doc.currentFrameHanko) && Boolean(doc.counterpartyFrameHanko),
		canDisputeAlone: Boolean(doc.counterpartyDisputeProofHanko),
		ourResponseSeconds: account.isLeft ? left : right,
		theirResponseSeconds: account.isLeft ? right : left,
		riskUsd,
		securedUsd,
		owedUsd,
		disputeTimeout: Number(doc.activeDispute?.disputeTimeout || 0),
		disputePhase: account.dispute,
	};
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '—';
	if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
	if (seconds % 60 === 0) return `${seconds / 60} min`;
	return `${seconds} s`;
}
