import type { EntityInput, EntityOutput, ServerTx, BankingTransaction } from '../types';

// Helper to safely stringify data with length limit
export function safeStringify(data: any, maxLength: number = 50): string {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > maxLength ? str.slice(0, maxLength) + '...' : str;
  } catch {
    return '[object]';
  }
}

// Banking-style input transaction rendering
export function renderBankingInput(input: EntityInput): BankingTransaction {
  let primaryInfo = 'Entity Input';
  let secondaryInfo = '';
  let amount = '';

  if (input.entityTxs && input.entityTxs.length > 0) {
    if (input.entityTxs.length === 1) {
      const tx = input.entityTxs[0];
      if (tx.type === 'chat') {
        primaryInfo = '💬 Chat Message';
        secondaryInfo = `"${tx.data.message}" from ${tx.data.from}`;
      } else if (tx.type === 'propose') {
        primaryInfo = '📝 Proposal';
        secondaryInfo = `${tx.data.action?.data?.message || 'New proposal'} by ${tx.data.proposer}`;
      } else if (tx.type === 'vote') {
        primaryInfo = '🗳️ Vote';
        secondaryInfo = `${tx.data.choice} on ${tx.data.proposalId?.slice(0, 8)}... from ${tx.data.voter || 'unknown'}`;
      } else {
        primaryInfo = `⚙️ ${tx.type}`;
        secondaryInfo = safeStringify(tx.data, 40);
      }
    } else {
      primaryInfo = `📦 ${input.entityTxs.length} Transactions`;
      const types = input.entityTxs.map((tx) => tx.type).join(', ');
      secondaryInfo = `Types: ${types}`;
      amount = `${input.entityTxs.length} txs`;
    }
  }

  if (input.precommits && input.precommits.size > 0) {
    const signers = Array.from(input.precommits.keys()).join(', ');
    if (primaryInfo === 'Entity Input') {
      primaryInfo = '🔐 Precommits';
      secondaryInfo = `${input.precommits.size} signatures from ${signers}`;
    } else {
      amount = `${input.precommits.size} precommits`;
    }
  }

  if (input.proposedFrame) {
    if (primaryInfo === 'Entity Input') {
      primaryInfo = '📋 Frame Proposal';
      secondaryInfo = `${input.proposedFrame.hash?.slice(0, 12)}... from ${input.signerId}`;
    }
  }

  return {
    type: 'input',
    icon: '📥',
    primaryInfo,
    secondaryInfo,
    amount,
  };
}

// Banking-style output transaction rendering
export function renderBankingOutput(output: EntityOutput): BankingTransaction {
  let primaryInfo = 'Entity Output';
  let secondaryInfo = '';
  let amount = '';

  if (output.entityTxs && output.entityTxs.length > 0) {
    if (output.entityTxs.length === 1) {
      const tx = output.entityTxs[0];
      const recipients = output.destinations?.join(', ') || 'network';
      if (tx.type === 'chat') {
        primaryInfo = '💬 Chat Sent';
        secondaryInfo = `"${tx.data.message}" to ${recipients}`;
      } else if (tx.type === 'propose') {
        primaryInfo = '📝 Proposal Sent';
        secondaryInfo = `${tx.data.action?.data?.message || 'New proposal'} to ${recipients}`;
      } else if (tx.type === 'vote') {
        primaryInfo = '🗳️ Vote Sent';
        secondaryInfo = `${tx.data.choice} on ${tx.data.proposalId?.slice(0, 8)}... to ${recipients}`;
      } else {
        primaryInfo = `⚙️ ${tx.type} Sent`;
        secondaryInfo = `${safeStringify(tx.data, 30)} to ${recipients}`;
      }
    } else {
      primaryInfo = `📦 ${output.entityTxs.length} Transactions Sent`;
      const types = output.entityTxs.map((tx) => tx.type).join(', ');
      const recipients = output.destinations?.join(', ') || 'network';
      secondaryInfo = `Types: ${types} to ${recipients}`;
      amount = `${output.entityTxs.length} txs`;
    }
  }

  if (output.precommits && output.precommits.size > 0) {
    if (primaryInfo === 'Entity Output') {
      primaryInfo = '🔐 Precommits Sent';
      secondaryInfo = `${output.precommits.size} signatures to ${output.destinations?.join(', ') || 'validators'}`;
    } else {
      amount = `${output.precommits.size} precommits`;
    }
  }

  if (output.proposedFrame) {
    if (primaryInfo === 'Entity Output') {
      primaryInfo = '📋 Frame Sent';
      secondaryInfo = `${output.proposedFrame.hash?.slice(0, 12)}... to ${output.destinations?.join(', ') || 'network'}`;
    }
  }

  return {
    type: 'output',
    icon: '📤',
    primaryInfo,
    secondaryInfo,
    amount,
  };
}

// Banking-style import transaction rendering
export function renderBankingImport(serverTx: ServerTx): BankingTransaction {
  let primaryInfo = '🔄 Replica Import';
  let secondaryInfo = `Imported from server`;
  let amount = '';

  if (serverTx.type === 'importReplica') {
    primaryInfo = '🔄 Replica Import';
    secondaryInfo = `Server imported ${serverTx.data?.signerId} (proposer: ${serverTx.data?.isProposer ? 'Yes' : 'No'})`;
    amount = 'IMPORT';
  }

  return {
    type: 'import',
    icon: '🔄',
    primaryInfo,
    secondaryInfo,
    amount,
  };
}
