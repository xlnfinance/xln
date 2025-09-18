/**
 * Cross-Entity Account Input Messaging
 * Handles sending AccountInput messages between entities
 */

import { AccountInput, AccountTx, EntityState, Env, EntityInput } from '../types';

/**
 * Send an AccountInput message to another entity
 * This creates a proper EntityInput that can be processed by the target entity
 */
export function sendAccountInputMessage(
  fromEntityState: EntityState,
  toEntityId: string,
  accountTx: AccountTx,
  env: Env,
  metadata?: { purpose?: string; description?: string }
): EntityInput {
  
  console.log(`📬 Sending AccountInput: ${fromEntityState.entityId.slice(-4)} → ${toEntityId.slice(-4)}`);
  console.log(`📬 Transaction type: ${accountTx.type}`);
  
  // Create AccountInput with proper routing
  const accountInput: AccountInput = {
    fromEntityId: fromEntityState.entityId,
    toEntityId,
    accountTx,
    metadata: metadata || {
      purpose: 'cross_entity_account_transaction',
      description: `${accountTx.type} from Entity ${fromEntityState.entityId.slice(-4)}`
    }
  };
  
  // Wrap in EntityInput for routing
  const entityInput: EntityInput = {
    entityId: toEntityId, // Target entity
    signerId: fromEntityState.entityId, // From entity as signer
    entityTxs: [{
      type: 'accountInput',
      data: accountInput
    }]
  };
  
  console.log(`✅ Created cross-entity EntityInput for ${toEntityId.slice(-4)}`);
  return entityInput;
}

/**
 * Send a direct payment to another entity
 */
export function sendDirectPaymentToEntity(
  fromEntityState: EntityState,
  toEntityId: string,
  tokenId: number,
  amount: bigint,
  env: Env,
  description?: string
): EntityInput {
  
  const paymentTx: AccountTx = {
    type: 'direct_payment',
    data: {
      tokenId,
      amount,
      description: description || `Direct payment of ${amount.toString()} token ${tokenId}`
    }
  };
  
  return sendAccountInputMessage(
    fromEntityState,
    toEntityId,
    paymentTx,
    env,
    {
      purpose: 'direct_payment',
      description: `Payment of ${amount.toString()} token ${tokenId} to Entity ${toEntityId.slice(-4)}`
    }
  );
}

/**
 * Send a credit limit update to another entity
 */
export function sendCreditLimitUpdateToEntity(
  fromEntityState: EntityState,
  toEntityId: string,
  tokenId: number,
  amount: bigint,
  isForSelf: boolean,
  env: Env
): EntityInput {
  
  const creditTx: AccountTx = {
    type: 'set_credit_limit',
    data: {
      tokenId,
      amount,
      isForSelf
    }
  };
  
  return sendAccountInputMessage(
    fromEntityState,
    toEntityId,
    creditTx,
    env,
    {
      purpose: 'credit_limit_update',
      description: `Set credit limit ${amount.toString()} for token ${tokenId} (${isForSelf ? 'self' : 'peer'})`
    }
  );
}

/**
 * Send account acknowledgment (for account opening)
 */
export function sendAccountAcknowledgment(
  fromEntityState: EntityState,
  toEntityId: string,
  message: string,
  env: Env
): EntityInput {
  
  const ackTx: AccountTx = {
    type: 'initial_ack',
    data: { message }
  };
  
  return sendAccountInputMessage(
    fromEntityState,
    toEntityId,
    ackTx,
    env,
    {
      purpose: 'account_acknowledgment',
      description: `Account acknowledgment: ${message}`
    }
  );
}

/**
 * Process multiple AccountInput messages as a batch
 * This can be used for bulk operations between entities
 */
export function sendBatchAccountInputs(
  fromEntityState: EntityState,
  toEntityId: string,
  accountTxs: AccountTx[],
  env: Env
): EntityInput[] {
  
  console.log(`📦 Sending batch of ${accountTxs.length} AccountInputs to ${toEntityId.slice(-4)}`);
  
  return accountTxs.map(accountTx => 
    sendAccountInputMessage(fromEntityState, toEntityId, accountTx, env)
  );
}

/**
 * Get cross-entity messaging summary for debugging
 */
export function getCrossEntityMessagingSummary(entityState: EntityState) {
  const accountCount = entityState.accounts.size;
  const queuedInputs = entityState.accountInputQueue?.length || 0;
  const activeAccounts = Array.from(entityState.accounts.entries()).map(([entityId, account]) => ({
    entityId,
    shortId: entityId.slice(-4),
    mempoolSize: account.mempool.length,
    frameId: account.currentFrame.frameId,
    tokenCount: account.deltas.size,
  }));
  
  return {
    entityId: entityState.entityId.slice(-4),
    accountCount,
    queuedInputs,
    activeAccounts,
    canSendMessages: accountCount > 0,
  };
}

/**
 * Validate AccountInput message before sending
 */
export function validateAccountInputMessage(accountInput: AccountInput): { valid: boolean; error?: string } {
  if (!accountInput.fromEntityId || !accountInput.toEntityId) {
    return { valid: false, error: 'Missing fromEntityId or toEntityId' };
  }
  
  if (accountInput.fromEntityId === accountInput.toEntityId) {
    return { valid: false, error: 'Cannot send AccountInput to self' };
  }
  
  if (!accountInput.accountTx || !accountInput.accountTx.type) {
    return { valid: false, error: 'Missing or invalid accountTx' };
  }
  
  return { valid: true };
}