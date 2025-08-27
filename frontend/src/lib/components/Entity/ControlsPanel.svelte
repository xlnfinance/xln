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

  // Get proposals for voting
  $: proposals = replica?.state?.proposals ? 
    Array.from(replica.state.proposals.entries()).map(([id, proposal]) => ({ id, ...proposal })) : [];

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
      
      // Direct processUntilEmpty for entityInputs (no serverTxs needed)
      await xln.processUntilEmpty(env, [{
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
      }]);
      
      console.log('✅ Vote submitted and processed successfully');
      selectedProposalId = '';
      voteChoice = '';
      voteComment = '';
    } catch (error) {
      console.error('Failed to submit vote:', error);
      alert(`Failed to submit vote: ${error.message}`);
    }
  }
</script>

<div class="controls-section">
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
    
    {:else}
      <div class="form-group">
        <label class="form-label">Action:</label>
        <div class="form-input" style="padding: 12px; background: #1e1e1e; border-radius: 4px; color: #666;">
          {selectedAction} controls will be implemented here
        </div>
      </div>
    {/if}
  </div>
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
</style>
