/**
 * Reserve → Collateral Handler (Account Level)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY: DISABLED - This handler should NOT be callable via direct AccountTx
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VULNERABILITY (God Mode Attack):
 * If this handler were enabled, an attacker could propose an account frame
 * containing `reserve_to_collateral` tx with arbitrary collateral values.
 * The victim would blindly apply it WITHOUT L1 proof verification.
 *
 * PROPER FLOW:
 * Collateral updates MUST go through bilateral j_event consensus:
 * 1. Entity observes L1 event (AccountSettled) via JAdapter.startWatching
 * 2. Entity stores observation in leftJObservations/rightJObservations
 * 3. Entity proposes j_event_claim tx to counterparty
 * 4. Both sides exchange j_event_claim → 2-of-2 agreement
 * 5. tryFinalizeAccountJEvents() applies state change ONLY after match
 *
 * See: entity-tx/j-events.ts:tryFinalizeAccountJEvents() for the safe implementation.
 *
 * Reference: Depository.sol reserveToCollateral (line 1035)
 * Reference: 2019src.txt lines 233-239 (reserveToChannel pattern)
 */

import type { AccountMachine, AccountTx } from '../../types';

/**
 * SECURITY: This handler is DISABLED to prevent "God Mode" attacks.
 *
 * Attackers could inject arbitrary collateral values without L1 proof.
 * All collateral updates MUST go through bilateral j_event consensus
 * via j_event_claim + tryFinalizeAccountJEvents.
 */
export function handleReserveToCollateral(
  _accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'reserve_to_collateral' }>
): { success: boolean; events: string[]; error?: string } {
  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY BLOCK: Reject all direct reserve_to_collateral transactions
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // This prevents "God Mode" attack where attacker sets arbitrary collateral:
  //   1. Attacker proposes frame with reserve_to_collateral(collateral=1M)
  //   2. Victim applies blindly → attacker has 1M collateral they don't own
  //
  // Legitimate R→C flows use j_event_claim which requires:
  //   - Both entities observe same L1 event (AccountSettled)
  //   - 2-of-2 bilateral agreement before applying state change
  // ═══════════════════════════════════════════════════════════════════════════

  const { tokenId, collateral } = accountTx.data;

  console.error(`❌ SECURITY: Blocked direct reserve_to_collateral tx`);
  console.error(`   tokenId=${tokenId}, collateral=${collateral}`);
  console.error(`   This tx type is DISABLED - use j_event_claim flow instead`);
  console.error(`   See entity-tx/j-events.ts for proper L1→bilateral consensus`);

  return {
    success: false,
    events: [],
    error: 'SECURITY: reserve_to_collateral blocked - must use j_event_claim bilateral consensus'
  };
}
