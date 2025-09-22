/**
 * Account Rebalancing Mathematics
 * Ported from old_src/app/Channel.ts:652-697
 *
 * Calculates derived values for bilateral account channels:
 * - Inbound/outbound capacity
 * - Credit usage
 * - Collateral allocation
 */
/**
 * Calculate derived values for a delta position
 * @param delta The account delta object
 * @param ownCreditLimit Credit we extend to peer
 * @param peerCreditLimit Credit peer extends to us
 * @param isCounterpartyView If true, flip perspective to counterparty's view
 */
export function deriveDelta(delta, ownCreditLimit, peerCreditLimit, isCounterpartyView = false) {
    const nonNegative = (x) => x < 0n ? 0n : x;
    // Total delta position (on-chain + off-chain)
    const totalDelta = delta.ondelta + delta.offdelta;
    const collateral = nonNegative(delta.collateral);
    // Calculate collateral allocation
    let inCollateral = totalDelta > 0n
        ? nonNegative(collateral - totalDelta)
        : collateral;
    let outCollateral = totalDelta > 0n
        ? (totalDelta > collateral ? collateral : totalDelta)
        : 0n;
    // Calculate credit usage
    let inOwnCredit = nonNegative(-totalDelta);
    if (inOwnCredit > ownCreditLimit) {
        inOwnCredit = ownCreditLimit;
    }
    let outPeerCredit = nonNegative(totalDelta - collateral);
    if (outPeerCredit > peerCreditLimit) {
        outPeerCredit = peerCreditLimit;
    }
    let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
    let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);
    // Allowances (reserved capacity)
    // TODO: Implement allowance logic when needed
    let inAllowance = 0n;
    let outAllowance = 0n;
    // Calculate total capacities
    const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;
    let inCapacity = nonNegative(inOwnCredit + inCollateral + inPeerCredit - inAllowance);
    let outCapacity = nonNegative(outPeerCredit + outCollateral + outOwnCredit - outAllowance);
    // Flip perspective if viewing from counterparty's side
    if (isCounterpartyView) {
        // Swap collateral and allowances
        [inCollateral, inAllowance, inCapacity,
            outCollateral, outAllowance, outCapacity] =
            [outCollateral, outAllowance, outCapacity,
                inCollateral, inAllowance, inCapacity];
        // Swap credit limits
        [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
        // Swap in<->out and own<->peer credit
        [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] =
            [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
    }
    return {
        delta: totalDelta,
        collateral,
        ownCreditLimit,
        peerCreditLimit,
        inCollateral,
        outCollateral,
        inOwnCredit,
        outOwnCredit,
        inPeerCredit,
        outPeerCredit,
        inAllowance,
        outAllowance,
        inCapacity,
        outCapacity,
        totalCapacity,
    };
}
/**
 * Get derived delta for a specific token in an account
 * @param account The account machine
 * @param tokenId The token to analyze
 * @param fromCounterpartyView View from counterparty's perspective
 */
export function getAccountCapacity(account, tokenId, fromCounterpartyView = false) {
    const delta = account.deltas.get(tokenId);
    if (!delta) {
        return null;
    }
    // Use global credit limits for now
    // TODO: Support per-token credit limits
    const ownLimit = account.globalCreditLimits.ownLimit;
    const peerLimit = account.globalCreditLimits.peerLimit;
    return deriveDelta(delta, ownLimit, peerLimit, fromCounterpartyView);
}
/**
 * Calculate the maximum payment that can be made
 * @param account The account machine
 * @param tokenId The token to pay with
 * @param direction 'send' or 'receive'
 */
export function calculateMaxPayment(account, tokenId, direction) {
    const capacity = getAccountCapacity(account, tokenId, false);
    if (!capacity) {
        return 0n;
    }
    return direction === 'send' ? capacity.outCapacity : capacity.inCapacity;
}
/**
 * Visual representation of delta position (ASCII art)
 * Shows the position within the credit-collateral-credit spectrum
 */
export function visualizeDelta(derived) {
    const total = derived.totalCapacity;
    if (total === 0n) {
        return '[No capacity]';
    }
    // Calculate position as percentage
    const position = Number(derived.delta + derived.ownCreditLimit) * 100 / Number(total);
    // Build ASCII visualization
    const width = 50;
    const markerPos = Math.floor(position * width / 100);
    let visual = '|';
    for (let i = 0; i < width; i++) {
        if (i === markerPos) {
            visual += '●';
        }
        else if (i < width * Number(derived.ownCreditLimit) / Number(total)) {
            visual += '←'; // Own credit zone
        }
        else if (i < width * Number(derived.ownCreditLimit + derived.collateral) / Number(total)) {
            visual += '='; // Collateral zone
        }
        else {
            visual += '→'; // Peer credit zone
        }
    }
    visual += '|';
    return visual;
}
