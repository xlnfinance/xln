<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  
  export let replica: EntityReplica | null;
  export let tab: Tab;

  let selectedAction = 'chat';
  let message = '';
  let proposalTitle = '';
  let proposalDescription = '';
  let selectedProposalId = '';
  let voteChoice = '';
  let voteComment = '';

  // State for J-tx (reserve-to-reserve)
  let jtxRecipient = '';
  let jtxAmount = 0;
  let jtxTokenId = '';


  // Get proposals for voting
  $: proposals = replica?.state?.proposals ? 
    Array.from(replica.state.proposals.entries()).map(([id, proposal]) => ({ id, ...proposal })) : [];

  // Get available tokens for sending
  $: availableTokens = replica?.state?.reserves
    ? Array.from(replica.state.reserves.entries()).map(([id, reserve]) => ({
        id: id,
        name: reserve.name || `Token #${id}`,
        amount: reserve.amount
      }))
    : [];


  async function submitChatMessage() {
    if (!tab.entityId || !tab.signer || !message.trim()) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Direct processUntilEmpty for entityInputs (no serverTxs needed)
      await xln.processUntilEmpty(env, [{
        entityId: tab.entityId,
        signerId: tab.signer,
        entityTxs: [{
          type: 'chat',
          data: { from: tab.signer, message: message.trim() }
        }]
      }]);
      
      console.log('💬 Chat message sent and processed:', message);
      message = '';
    } catch (error) {
      console.error('Failed to send chat message:', error);
      alert(`Failed to send message: ${error.message}`);
    }
  }

  async function submitProposal() {
    if (!tab.entityId || !tab.signer || !proposalTitle.trim()) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      const proposalText = proposalTitle.trim() + (proposalDescription.trim() ? ': ' + proposalDescription.trim() : '');
      
      // Direct processUntilEmpty for entityInputs (no serverTxs needed)
      await xln.processUntilEmpty(env, [{
        entityId: tab.entityId,
        signerId: tab.signer,
        entityTxs: [{
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: proposalText } },
            proposer: tab.signer
          }
        }]
      }]);
      
      console.log('📝 Proposal sent and processed:', proposalText);
      proposalTitle = '';
      proposalDescription = '';
    } catch (error) {
      console.error('Failed to send proposal:', error);
      alert(`Failed to send proposal: ${error.message}`);
    }
  }

  async function submitVote() {
    if (!tab.entityId || !tab.signer || !selectedProposalId || !voteChoice) return;
    
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // Check if already voted (same logic as legacy)
      const currentProposal = replica?.state?.proposals?.get(selectedProposalId);
      if (currentProposal && currentProposal.votes.has(tab.signer)) {
        alert(`You have already voted on this proposal as "${currentProposal.votes.get(tab.signer)}".`);
        return;
      }

      const voteValue = voteChoice === 'yes' ? 'yes' : voteChoice === 'no' ? 'no' : 'abstain';
      
      const voteInput = {
        entityId: tab.entityId,
        signerId: tab.signer,
        entityTxs: [{
          type: 'vote',
          data: {
            proposalId: selectedProposalId,
            voter: tab.signer,
            choice: voteValue,
            comment: voteComment.trim() || undefined
          }
        }]
      };
      
      console.log('🗳️ FRONTEND-DEBUG: About to submit vote:', {
        entityId: tab.entityId,
        signerId: tab.signer,
        proposalId: selectedProposalId,
        choice: voteValue,
        txType: 'vote'
      });
      
      // Direct processUntilEmpty for entityInputs (no serverTxs needed)
      await xln.processUntilEmpty(env, [voteInput]);
      
      console.log('✅ Vote submitted and processed successfully');
      selectedProposalId = '';
      voteChoice = '';
      voteComment = '';
    } catch (error) {
      console.error('Failed to submit vote:', error);
      alert(`Failed to submit vote: ${error.message}`);
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
    if (!tab.entityId || !tab.signer || !jtxRecipient.trim() || !jtxAmount || !jtxTokenId) {
      alert('Please fill in all fields for the transfer.');
      return;
    }

    const recipientAddress = resolveRecipient(jtxRecipient.trim());
    const tokenIdNum = Number(jtxTokenId);

    if (isNaN(tokenIdNum)) {
      alert('Invalid token selected. Please ensure the dropdown value is a number.');
      return;
    }
    if (jtxAmount <= 0) {
      alert('Amount must be greater than zero.');
      return;
    }

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // This is the correct structure for a Depository batch transaction
      const batch = {
        reserveToReserve: [{
          receivingEntity: recipientAddress,
          tokenId: tokenIdNum,
          amount: jtxAmount,
        }],
        // Explicitly set other batch arrays to empty to ensure a clean transaction
        reserveToExternalToken: [],
        externalTokenToReserve: [],
        reserveToCollateral: [],
        cooperativeUpdate: [],
        cooperativeDisputeProof: [],
        initialDisputeProof: [],
        finalDisputeProof: [],
        flashloans: [],
        hub_id: 0,
      };

      // Real blockchain submission: UI → j-machine → j-watcher → entity machine
      console.log('💸 Submitting REAL processBatch to blockchain...');
      
      // Get jurisdiction info
      const ethJurisdiction = await xln.getJurisdictionByAddress('ethereum');
      if (!ethJurisdiction) {
        throw new Error('Ethereum jurisdiction not found');
      }
      
      // Submit real transaction to deployed Depository contract
      const result = await xln.submitProcessBatch(ethJurisdiction, tab.entityId, batch);
      console.log('✅ Real blockchain transaction confirmed:', result.receipt.hash);
      
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
      alert(`Failed to send J-tx: ${error.message}`);
    }
  }
</script>

<div class="controls-section">
  {#if !tab.entityId || !tab.signer}
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
      <option value="entity">🏛️ Form new entity</option>
      <option value="jtx">💸 Send J-tx</option>
      <option value="settings">⚙️ Update settings</option>
    </select>
    
    <div class="controls-form">
    {#if selectedAction === 'chat'}
      <div class="form-group">
        <label class="form-label">Message:</label>
        <textarea class="form-textarea" bind:value={message} placeholder="Enter your message..."></textarea>
      </div>
      <button class="form-button" on:click={submitChatMessage}>Send Message</button>
    
    {:else if selectedAction === 'proposal'}
      <div class="form-group">
        <label class="form-label">Proposal Title:</label>
        <input class="form-input" type="text" bind:value={proposalTitle} placeholder="Enter proposal title..." />
      </div>
      <div class="form-group">
        <label class="form-label">Description:</label>
        <textarea class="form-textarea" bind:value={proposalDescription} placeholder="Enter proposal description..."></textarea>
      </div>
      <button class="form-button" on:click={submitProposal}>Create Proposal</button>
    
    {:else if selectedAction === 'vote'}
      <div class="form-group">
        <label class="form-label">Select Proposal:</label>
        <select class="form-input" bind:value={selectedProposalId}>
          <option value="">Select a proposal...</option>
          {#each proposals as proposal}
            <option value={proposal.id}>{proposal.action?.data?.message || 'Proposal ' + proposal.id}</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Vote:</label>
        <select class="form-input" bind:value={voteChoice}>
          <option value="">Select your vote...</option>
          <option value="yes">✅ Yes</option>
          <option value="no">❌ No</option>
          <option value="abstain">🤷 Abstain</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Comment (optional):</label>
        <textarea class="form-textarea" bind:value={voteComment} placeholder="Add a comment to your vote..."></textarea>
      </div>
      <button class="form-button" on:click={submitVote}>Submit Vote</button>
    
    {:else if selectedAction === 'jtx'}
      <div class="form-group">
        <label class="form-label">Recipient Address:</label>
        <input class="form-input" type="text" bind:value={jtxRecipient} placeholder="Enter recipient's entity ID or address..." />
      </div>
      <div class="form-group">
        <label class="form-label">Token:</label>
        <select class="form-input" bind:value={jtxTokenId}>
          <option value="">Select a token...</option>
          {#each availableTokens as token}
            <option value={token.id}>{token.name} (Balance: {token.amount})</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Amount:</label>
        <input class="form-input" type="number" bind:value={jtxAmount} placeholder="0.0" />
      </div>
      <button class="form-button" on:click={submitJtx}>Send Transfer</button>

    {:else}
      <div class="form-group">
        <label class="form-label">Action:</label>
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
</style>
