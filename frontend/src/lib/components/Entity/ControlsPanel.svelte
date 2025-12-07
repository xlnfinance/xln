<script lang="ts">
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import { getXLN, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  let selectedAction = 'chat';
  let message = '';
  let proposalTitle = '';
  let proposalDescription = '';
  let selectedProposalId = '';
  let voteChoice = '';
  let voteComment = '';

  // State for J-tx (reserve-to-reserve) - Set defaults for easier testing
  let jtxRecipient = '2';
  let jtxAmount = 0.1;
  let jtxTokenId = '1';

  // State for account opening
  let accountCounterparty = '2';


  // Get proposals for voting
  // Safari requires explicit Map check before calling .entries()
  $: proposals = (replica?.state?.proposals && replica.state.proposals instanceof Map) ?
    Array.from(replica.state.proposals.entries()).map(([proposalId, proposal]) => ({ ...proposal, id: proposalId })) : [];

  // Get available tokens for sending
  $: availableTokens = (replica?.state?.reserves && replica.state.reserves instanceof Map)
    ? Array.from(replica.state.reserves.entries()).map(([id, reserve]) => ({
        id: id,
        name: `Token #${id}`,
        amount: reserve
      }))
    : [];

  // Get all other entities for account opening
  $: otherEntities = $xlnEnvironment?.eReplicas
    ? Array.from(new Set(
        Array.from($xlnEnvironment.eReplicas.keys() as IterableIterator<string>)
          .map(key => key.split(':')[0]!)
          .filter((entityId): entityId is string => !!entityId && entityId !== tab.entityId)
      ))
    : [];


  async function submitChatMessage() {
    if (!tab.entityId || !tab.signerId || !message.trim()) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Direct process() for entityInputs (no runtimeTxs needed)
      await xln.process(env, [{
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'chat',
          data: { from: tab.signerId, message: message.trim() }
        }]
      }]);
      
      console.log('💬 Chat message sent and processed:', message);
      message = '';
    } catch (error) {
      console.error('Failed to send chat message:', error);
      alert(`Failed to send message: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function submitProposal() {
    if (!tab.entityId || !tab.signerId || !proposalTitle.trim()) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      const proposalText = proposalTitle.trim() + (proposalDescription.trim() ? ': ' + proposalDescription.trim() : '');
      
      // Direct process() for entityInputs (no runtimeTxs needed)
      await xln.process(env, [{
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: proposalText } },
            proposer: tab.signerId
          }
        }]
      }]);
      
      console.log('📝 Proposal sent and processed:', proposalText);
      proposalTitle = '';
      proposalDescription = '';
    } catch (error) {
      console.error('Failed to send proposal:', error);
      alert(`Failed to send proposal: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function submitVote() {
    if (!tab.entityId || !tab.signerId || !selectedProposalId || !voteChoice) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Check if already voted (same logic as legacy)
      const currentProposal = replica?.state?.proposals?.get(selectedProposalId);
      if (currentProposal && currentProposal.votes.has(tab.signerId)) {
        const msg = `You have already voted on this proposal as "${currentProposal.votes.get(tab.signerId)}".`;
        console.error('❌ Vote validation failed:', msg);
        alert(msg);
        return;
      }

      const voteValue = voteChoice === 'yes' ? 'yes' : voteChoice === 'no' ? 'no' : 'abstain';
      
      const voteInput = {
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'vote',
          data: {
            proposalId: selectedProposalId,
            voter: tab.signerId,
            choice: voteValue,
            comment: voteComment.trim() || undefined
          }
        }]
      };
      
      console.log('🗳️ FRONTEND-DEBUG: About to submit vote:', {
        entityId: tab.entityId,
        signerId: tab.signerId,
        proposalId: selectedProposalId,
        choice: voteValue,
        txType: 'vote'
      });
      
      // Direct process() for entityInputs (no runtimeTxs needed)
      await xln.process(env, [voteInput]);
      
      console.log('✅ Vote submitted and processed successfully');
      selectedProposalId = '';
      voteChoice = '';
      voteComment = '';
    } catch (error) {
      console.error('Failed to submit vote:', error);
      alert(`Failed to submit vote: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function openAccount() {
    if (!tab.entityId || !tab.signerId || !accountCounterparty) return;

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      const accountInput = {
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'accountInput',
          data: {
            fromEntityId: tab.entityId,
            toEntityId: accountCounterparty,
            accountTx: {
              type: 'initial_ack',
              data: { message: 'Account opening request' }
            }
          }
        }]
      };

      console.log('💳 Opening account with entity:', accountCounterparty);

      await xln.process(env, [accountInput]);

      console.log('✅ Account opened successfully');
      accountCounterparty = '';
    } catch (error) {
      console.error('Failed to open account:', error);
      alert(`Failed to open account: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  function resolveRecipient(recipient: string): string {
    // Check if it's a simple number (entity number)
    if (/^\d+$/.test(recipient)) {
      const entityNumber = BigInt(recipient);
      // Return the full bytes32 entityId
      return '0x' + entityNumber.toString(16).padStart(64, '0');
    }
    // Assume it's already an address or a bytes32 string
    // TODO: Add proper address/bytes32 validation
    return recipient;
  }

  async function submitJtx() {
    if (!tab.entityId || !tab.signerId || !jtxRecipient.trim() || !jtxAmount || !jtxTokenId) {
      const msg = 'Please fill in all fields for the transfer.';
      console.error('❌ Transfer validation failed:', msg);
      alert(msg);
      return;
    }

    const recipientAddress = resolveRecipient(jtxRecipient.trim());
    const tokenIdNum = Number(jtxTokenId);

    console.log('🔍 R2R Transfer Debug:');
    console.log('  From Entity:', tab.entityId);
    console.log('  To Entity:', recipientAddress);
    console.log('  Token ID:', tokenIdNum);
    console.log('  Amount:', jtxAmount);

    if (isNaN(tokenIdNum)) {
      const msg = 'Invalid token selected. Please ensure the dropdown value is a number.';
      console.error('❌ Transfer validation failed:', msg);
      alert(msg);
      return;
    }
    if (jtxAmount <= 0) {
      const msg = 'Amount must be greater than zero.';
      console.error('❌ Transfer validation failed:', msg);
      alert(msg);
      return;
    }

    // Check for self-transfer
    if (tab.entityId === recipientAddress) {
      const msg = `Cannot transfer to yourself!\n\nYou are Entity #1 (${tab.entityId})\nTrying to send to: ${recipientAddress}\n\nTip: Try entering "2" to send to Entity #2 instead.`;
      console.error('❌ Transfer validation failed:', msg);
      alert(msg);
      return;
    }

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');


      // Use SIMPLE reserveToReserve (what worked before!)
      console.log('💸 Submitting SIMPLE reserveToReserve to blockchain...');

      // Get jurisdiction info with debug
      console.log('🔍 Getting ethereum jurisdiction...');
      const ethJurisdiction = await xln.getJurisdictionByAddress('ethereum');
      if (!ethJurisdiction) {
        throw new Error('Ethereum jurisdiction not found');
      }
      console.log('🔍 Found jurisdiction:', ethJurisdiction);

      // Simple batch with ONLY reserveToReserve (like before)
      const simpleBatch = {
        reserveToReserve: [{
          receivingEntity: recipientAddress,
          tokenId: tokenIdNum,
          amount: jtxAmount,
        }],
        reserveToExternalToken: [],
        externalTokenToReserve: [],
        reserveToCollateral: [],
        settlements: [], // Required by new ABI but empty
        cooperativeUpdate: [],
        cooperativeDisputeProof: [],
        initialDisputeProof: [],
        finalDisputeProof: [],
        flashloans: [],
        hub_id: 0,
      };

      console.log('🔍 Simple R2R batch:', simpleBatch);

      // Use DIRECT reserveToReserve function call (simplest possible!)
      const weiAmount = (BigInt(Math.floor(jtxAmount * 1e18))).toString();
      const result = await xln.submitReserveToReserve(ethJurisdiction, tab.entityId, recipientAddress, tokenIdNum, weiAmount);
      console.log('✅ Direct R2R function call confirmed:', result.txHash);
      
      // Now wait for j-watcher to pick up the ReserveUpdated events and feed to entity machine
      // The j-watcher should automatically detect the events and create entity inputs
      console.log('⏳ Waiting for j-watcher to process events...');
      
      // Give j-watcher time to process events
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('💸 Reserve transfer sent successfully to', recipientAddress);
      
      // Reset form
      jtxRecipient = '';
      jtxAmount = 0;
      jtxTokenId = '';

    } catch (error) {
      console.error('Failed to send J-tx:', error);
      alert(`Failed to send J-tx: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }
</script>

<div class="controls-section">
  {#if !tab.entityId || !tab.signerId}
    <div class="empty-controls">
      <div class="empty-message">
        <h4>🎯 Select Entity & Signer First</h4>
        <p>Please use the dropdown above to select:</p>
        <ul>
          <li>📍 <strong>Jurisdiction</strong> (network)</li>
          <li>👤 <strong>Signer</strong> (your identity)</li>
          <li>🏢 <strong>Entity</strong> (which entity to control)</li>
        </ul>
        <small>Once selected, controls will appear here for chat, proposals, voting, etc.</small>
      </div>
    </div>
  {:else}
    <select class="controls-dropdown" bind:value={selectedAction}>
      <option value="chat" selected>💬 Create chat message</option>
      <option value="proposal">📋 Add proposal</option>
      <option value="vote">🗳️ Vote on proposal</option>
      <option value="account">💳 Open account</option>
      <option value="entity">🏛️ Form new entity</option>
      <option value="jtx">💸 Send J-tx</option>
      <option value="settings">⚙️ Update settings</option>
    </select>
    
    <div class="controls-form">
    {#if selectedAction === 'chat'}
      <div class="form-group">
        <label class="form-label" for="chat-message">Message:</label>
        <textarea id="chat-message" class="form-textarea" bind:value={message} placeholder="Enter your message..."></textarea>
      </div>
      <button class="form-button" on:click={submitChatMessage}>Send Message</button>
    
    {:else if selectedAction === 'proposal'}
      <div class="form-group">
        <label class="form-label" for="proposal-title">Proposal Title:</label>
        <input id="proposal-title" class="form-input" type="text" bind:value={proposalTitle} placeholder="Enter proposal title..." />
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-desc">Description:</label>
        <textarea id="proposal-desc" class="form-textarea" bind:value={proposalDescription} placeholder="Enter proposal description..."></textarea>
      </div>
      <button class="form-button" on:click={submitProposal}>Create Proposal</button>
    
    {:else if selectedAction === 'vote'}
      <div class="form-group">
        <label class="form-label" for="vote-proposal">Select Proposal:</label>
        <select id="vote-proposal" class="form-input" bind:value={selectedProposalId}>
          <option value="">Select a proposal...</option>
          {#each proposals as proposal}
            <option value={proposal.id}>{proposal.action?.data?.message || 'Proposal ' + proposal.id}</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="vote-choice">Vote:</label>
        <select id="vote-choice" class="form-input" bind:value={voteChoice}>
          <option value="">Select your vote...</option>
          <option value="yes">✅ Yes</option>
          <option value="no">❌ No</option>
          <option value="abstain">🤷 Abstain</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="vote-comment">Comment (optional):</label>
        <textarea id="vote-comment" class="form-textarea" bind:value={voteComment} placeholder="Add a comment to your vote..."></textarea>
      </div>
      <button class="form-button" on:click={submitVote}>Submit Vote</button>
    
    {:else if selectedAction === 'jtx'}
      <div class="form-group">
        <label class="form-label" for="jtx-recipient">Recipient Entity:</label>
        <input id="jtx-recipient" class="form-input" type="text" bind:value={jtxRecipient} placeholder="Entity number (e.g., 2, 3) or full entity ID..." />
        <div class="form-hint">
          💡 Tip: Try entity number "2" to transfer to Entity #2
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="jtx-token">Token:</label>
        <select id="jtx-token" class="form-input" bind:value={jtxTokenId}>
          <option value="">Select a token...</option>
          {#each availableTokens as token}
            <option value={token.id}>{token.name} (Balance: {token.amount})</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="jtx-amount">Amount:</label>
        <input id="jtx-amount" class="form-input" type="number" bind:value={jtxAmount} placeholder="0.0" />
      </div>
      <button class="form-button" on:click={submitJtx}>Send Transfer</button>

    {:else if selectedAction === 'account'}
      <div class="form-group">
        <label class="form-label" for="account-counterparty">Counterparty Entity:</label>
        <select id="account-counterparty" class="form-input" bind:value={accountCounterparty}>
          <option value="">Select entity...</option>
          {#each otherEntities as entityId}
            <option value={entityId}>
              Entity #{$xlnFunctions?.getEntityNumber?.(entityId) || entityId.slice(0, 10)}
            </option>
          {/each}
        </select>
        {#if otherEntities.length === 0}
          <div class="form-hint">
            💡 No other entities available. Create more entities first.
          </div>
        {/if}
      </div>
      <button class="form-button" on:click={openAccount} disabled={!accountCounterparty}>
        Open Account
      </button>

    {:else}
      <div class="form-group">
        <span class="form-label">Action: {selectedAction}</span>
        <div class="form-input" style="padding: 12px; background: #1e1e1e; border-radius: 4px; color: #666;">
          {selectedAction} controls will be implemented here
        </div>
      </div>
    {/if}
    </div>
  {/if}
</div>

<style>
  .controls-section {
    padding: 12px;
  }

  .controls-dropdown {
    width: 100%;
    padding: 8px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 4px;
    color: #d4d4d4;
    margin-bottom: 12px;
  }

  .controls-form {
    transition: all 0.3s ease;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-label {
    display: block;
    color: #9d9d9d;
    font-size: 0.85em;
    margin-bottom: 4px;
  }

  .form-input,
  .form-textarea {
    width: 100%;
    padding: 6px 8px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.85em;
    resize: vertical;
  }

  .form-textarea {
    min-height: 60px;
  }

  .form-button {
    background: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    transition: background-color 0.2s ease;
  }

  .form-button:hover {
    background: #0086e6;
  }

  .empty-controls {
    text-align: center;
    padding: 20px;
  }

  .empty-message {
    background: #2d2d2d;
    border: 2px dashed #555;
    border-radius: 8px;
    padding: 20px;
    color: #d4d4d4;
  }

  .empty-message h4 {
    margin: 0 0 12px 0;
    color: #007acc;
  }

  .empty-message ul {
    text-align: left;
    margin: 12px 0;
    padding-left: 20px;
  }

  .empty-message li {
    margin: 8px 0;
  }

  .empty-message small {
    color: #999;
    font-style: italic;
  }

  .form-hint {
    font-size: 0.8em;
    color: #007acc;
    margin-top: 4px;
    font-style: italic;
  }
</style>
