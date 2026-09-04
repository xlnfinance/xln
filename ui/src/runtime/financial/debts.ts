/**
 * On-chain debts recorded by the Depository (`outDebtsByToken` = what this
 * entity owes, `inDebtsByToken` = what others owe it), and the one action the
 * wallet has: enforce repayment from its own reserve, FIFO, the same
 * `buildDebtEnforcementRuntimeInputFromProjection` the frontend sends.
 */
import type { DebtEntry } from '@xln/core/types/finance/debt';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import { requireAdapter } from '../adapter';
import { getXLN } from '../xln-loader';

export type DebtGroup = {
	tokenId: number;
	direction: 'out' | 'in';
	entries: DebtEntry[];
	outstanding: bigint;
	/** Next debt the Depository will settle first. */
	nextIndex: number | null;
};

/** Same slot budget as the SvelteKit debt panel. */
export const DEBT_DRAIN_MAX_SLOTS = 100;

const queueIndex = (entry: DebtEntry): number => {
	const index = entry.currentDebtIndex ?? entry.createdDebtIndex;
	return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
};

function flatten(ledger: Map<number, Map<string, DebtEntry>> | undefined, direction: 'out' | 'in'): DebtGroup[] {
	if (!ledger) return [];
	const groups: DebtGroup[] = [];
	for (const [tokenId, bucket] of ledger.entries()) {
		const entries = Array.from(bucket.values()).sort((left, right) => queueIndex(left) - queueIndex(right) || String(left.debtId).localeCompare(String(right.debtId)));
		if (entries.length === 0) continue;
		const open = entries.filter(entry => entry.remainingAmount > 0n);
		groups.push({
			tokenId: Number(tokenId),
			direction,
			entries,
			outstanding: open.reduce((sum, entry) => sum + entry.remainingAmount, 0n),
			nextIndex: open.length > 0 ? queueIndex(open[0]!) : null,
		});
	}
	return groups.sort((left, right) => left.tokenId - right.tokenId);
}

export function debtGroups(frame: RuntimeAdapterViewFrame | null): { owed: DebtGroup[]; owedToUs: DebtGroup[] } {
	const core = frame?.activeEntity?.core;
	return { owed: flatten(core?.outDebtsByToken, 'out'), owedToUs: flatten(core?.inDebtsByToken, 'in') };
}

/** Pay down open debts in one token from the reserve, up to `maxIterations` debt slots. */
export async function enforceDebts(input: { entityId: string; signerId: string; jurisdictionName: string; tokenId: number; maxIterations?: number }): Promise<void> {
	const xln = await getXLN();
	const runtimeInput = xln.buildDebtEnforcementRuntimeInputFromProjection({
		entityId: input.entityId,
		jurisdictionName: input.jurisdictionName,
		tokenId: input.tokenId,
		maxIterations: input.maxIterations ?? DEBT_DRAIN_MAX_SLOTS,
		signerId: input.signerId,
		timestamp: Date.now(),
	});
	await requireAdapter().send(runtimeInput);
}
