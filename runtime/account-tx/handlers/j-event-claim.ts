import type { AccountMachine, AccountTx, Env } from '../../types';
import { getAccountPerspective } from '../../state-helpers';
import { canonicalJurisdictionEventKey, normalizeJurisdictionEvents } from '../../j-event-normalization';
import { tryFinalizeAccountJEvents } from '../../entity-tx/j-events';

export function handleJEventClaim(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'j_event_claim' }>,
  byLeft: boolean,
  currentTimestamp: number,
  isValidation: boolean,
  myEntityId: string,
  emitRebalanceDebug: (payload: Record<string, unknown>) => void,
  env?: Env,
): { success: boolean; events: string[]; error?: string } {
  const { jHeight, jBlockHash, events, observedAt } = accountTx.data;
  console.log(`📥 j_event_claim: jHeight=${jHeight}, hash=${jBlockHash.slice(0, 10)}, byLeft=${byLeft}`);

  if (!accountMachine.leftJObservations) accountMachine.leftJObservations = [];
  if (!accountMachine.rightJObservations) accountMachine.rightJObservations = [];
  if (!accountMachine.jEventChain) accountMachine.jEventChain = [];
  if (accountMachine.lastFinalizedJHeight === undefined) accountMachine.lastFinalizedJHeight = 0;

  const MAX_J_HEIGHT_JUMP = 10000;
  if (jHeight > accountMachine.lastFinalizedJHeight + MAX_J_HEIGHT_JUMP) {
    return {
      success: false,
      events: [`❌ j_event_claim: jHeight ${jHeight} too far ahead`],
      error: `Invalid jHeight: jump too large (max ${MAX_J_HEIGHT_JUMP})`,
    };
  }

  if (jHeight <= accountMachine.lastFinalizedJHeight) {
    console.log(
      `   ℹ️ j_event_claim: jHeight ${jHeight} already finalized (lastFinalized=${accountMachine.lastFinalizedJHeight}) - skipping`,
    );
    return { success: true, events: [`ℹ️ j_event_claim skipped (already finalized)`] };
  }

  const { counterparty: cpId } = getAccountPerspective(accountMachine, myEntityId);
  const claimIsFromLeft = byLeft;
  const normalizedEvents = normalizeJurisdictionEvents(events);
  if (normalizedEvents.length === 0) {
    return {
      success: false,
      events: [`❌ j_event_claim non-canonical events payload`],
      error: `j_event_claim rejected: non-canonical events for ${jHeight}:${String(jBlockHash).slice(0, 10)}`,
    };
  }

  const sideObservations = claimIsFromLeft ? accountMachine.leftJObservations : accountMachine.rightJObservations;
  const existingObs = sideObservations.find(
    (o: any) => Number(o?.jHeight) === Number(jHeight) && String(o?.jBlockHash || '') === String(jBlockHash || ''),
  );

  if (existingObs) {
    const existingNormalized = normalizeJurisdictionEvents(existingObs.events);
    const existingKeys = new Set(existingNormalized.map(canonicalJurisdictionEventKey));
    let merged = 0;
    for (const ev of normalizedEvents) {
      const key = canonicalJurisdictionEventKey(ev);
      if (existingKeys.has(key)) continue;
      existingObs.events.push(ev);
      existingKeys.add(key);
      merged += 1;
    }
    if (observedAt > (existingObs.observedAt || 0)) {
      existingObs.observedAt = observedAt;
    }
    if (merged > 0) {
      console.log(
        `   🔁 j_event_claim MERGED: side=${claimIsFromLeft ? 'left' : 'right'} jHeight=${jHeight} ` +
          `added=${merged} total=${existingObs.events.length}`,
      );
    } else {
      console.log(
        `   ℹ️ j_event_claim duplicate ignored: side=${claimIsFromLeft ? 'left' : 'right'} jHeight=${jHeight} ` +
          `hash=${String(jBlockHash).slice(0, 10)}`,
      );
    }
  } else {
    sideObservations.push({ jHeight, jBlockHash, events: normalizedEvents, observedAt });
    console.log(`   📝 Stored ${claimIsFromLeft ? 'LEFT' : 'RIGHT'} obs (${sideObservations.length} total)`);
  }

  if (!isValidation) {
    const beforeFinalizedHeight = accountMachine.lastFinalizedJHeight || 0;
    tryFinalizeAccountJEvents(accountMachine, cpId, { timestamp: currentTimestamp });
    const afterFinalizedHeight = accountMachine.lastFinalizedJHeight || 0;
    const settledTokenId = Number(normalizedEvents.find(e => e.type === 'AccountSettled')?.data?.tokenId ?? 1);
    const delta = accountMachine.deltas.get(settledTokenId);
    if (afterFinalizedHeight > beforeFinalizedHeight) {
      if (env) {
        env.emit('account_settled_finalized_bilateral', {
          entityId: myEntityId,
          accountId: cpId,
          tokenId: settledTokenId,
          jHeight: afterFinalizedHeight,
          collateral: String(delta?.collateral ?? 0n),
          ondelta: String(delta?.ondelta ?? 0n),
        });
      }
      emitRebalanceDebug({
        step: 5,
        status: 'ok',
        event: 'account_settled_finalized_bilateral',
        jHeight: afterFinalizedHeight,
        accountId: cpId,
        tokenId: settledTokenId,
        collateral: String(delta?.collateral ?? 0n),
        ondelta: String(delta?.ondelta ?? 0n),
      });
    }
  }

  return { success: true, events: [`📥 J-event claim processed`] };
}
