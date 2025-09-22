/**
 * Simple Account Transaction Processor
 * Minimal implementation for DirectPayment processing
 */
import { applyDirectPayment } from './direct-payment';
/**
 * Determine payment direction based on account context
 * Similar to old_src Channel isLeft logic
 */
function determinePaymentDirection(accountMachine, transaction, currentFrameIsOurs) {
    // If we're processing our own frame, then direct_payment is outgoing
    // If we're processing counterparty's frame, then their direct_payment is incoming to us
    if (transaction.type === 'direct_payment') {
        return currentFrameIsOurs; // Our frame = outgoing, their frame = incoming
    }
    return true; // Default to outgoing for other types
}
/**
 * Process a single account transaction with proper direction logic
 */
export function processAccountTransaction(accountMachine, transaction, currentFrameIsOurs = true) {
    console.log(`🔄 Processing account transaction: ${transaction.type} (frameIsOurs: ${currentFrameIsOurs})`);
    switch (transaction.type) {
        case 'initial_ack':
            console.log(`👋 Processing initial acknowledgment: ${transaction.data.message}`);
            return {
                success: true,
                events: [`🤝 Account initialized with Entity ${accountMachine.counterpartyEntityId.slice(-4)}`]
            };
        case 'account_settle':
            console.log(`💰 Account settlement already processed in account handler`);
            return {
                success: true,
                events: [`⚖️ Settlement processed with Entity ${accountMachine.counterpartyEntityId.slice(-4)}`]
            };
        case 'direct_payment': {
            const isOutgoing = determinePaymentDirection(accountMachine, transaction, currentFrameIsOurs);
            console.log(`💸 DirectPayment direction: ${isOutgoing ? 'OUTGOING' : 'INCOMING'} (processing ${currentFrameIsOurs ? 'our' : 'their'} frame)`);
            return applyDirectPayment(accountMachine, transaction.data, isOutgoing);
        }
        default:
            return { success: false, error: `Unknown transaction type: ${transaction.type}` };
    }
}
/**
 * Process all pending transactions in mempool
 */
export function processAccountMempool(accountMachine) {
    console.log(`🔄 Processing ${accountMachine.mempool.length} account transactions for ${accountMachine.counterpartyEntityId}`);
    while (accountMachine.mempool.length > 0) {
        const transaction = accountMachine.mempool.shift();
        try {
            const result = processAccountTransaction(accountMachine, transaction);
            if (result.success) {
                console.log(`✅ Processed ${transaction.type} successfully`);
                accountMachine.sentTransitions++;
            }
            else {
                console.error(`❌ Failed to process ${transaction.type}: ${result.error}`);
                accountMachine.mempool.unshift(transaction);
                break;
            }
        }
        catch (error) {
            console.error(`💥 Error processing ${transaction.type}:`, error);
        }
    }
}
