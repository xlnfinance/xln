<script lang="ts">
  import type { EntityReplica, Tab } from '$lib/types/ui';

  export let replica: EntityReplica | null;
  export let tab: Tab; void tab; // Reserved for tab-aware features

  // Helper to convert BigInt to number safely
  function toNumber(value: any): number {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    return parseInt(value) || 0;
  }

  // Helper to extract vote choice from either simple or complex format
  function getVoteChoice(voteData: any): string {
    if (typeof voteData === 'object' && voteData.choice) {
      return voteData.choice; // Complex format: { choice: "yes", comment: "..." }
    }
    if (voteData === true) return 'yes';
    if (voteData === false) return 'no';
    return voteData; // Simple format: "yes", "no", "abstain"
  }

  // Helper to get vote display and calculate voting power
  function getVoteInfo(proposal: any, config: any) {
    const votes = proposal.votes ? [...proposal.votes.entries()] : [];
    const yesVotes = votes.filter(([_, vote]) => getVoteChoice(vote) === 'yes');
    const noVotes = votes.filter(([_, vote]) => getVoteChoice(vote) === 'no');
    const abstainVotes = votes.filter(([_, vote]) => getVoteChoice(vote) === 'abstain');

    const threshold = toNumber(config?.threshold || 1);
    const shares = config?.shares || {};

    // Calculate total voting power of YES votes
    const yesVotingPower = yesVotes.reduce((total, [voter, _]) => {
      const voterShares = toNumber(shares[voter] || 0);
      return total + voterShares;
    }, 0);

    const status = yesVotingPower >= threshold ? 'APPROVED' : 'PENDING';

    return {
      yesCount: yesVotes.length,
      noCount: noVotes.length,
      abstainCount: abstainVotes.length,
      yesVotingPower,
      threshold,
      status,
      votes
    };
  }
</script>

<div class="scrollable-component proposals-list">
  {#if replica && replica.state?.proposals && replica.state.proposals instanceof Map && replica.state.proposals.size > 0}
    {#each Array.from(replica.state.proposals.entries()) as [, proposal]}
      {@const voteInfo = getVoteInfo(proposal, replica.state?.config)}
      <div class="proposal-item">
        <div class="proposal-header">
          <div class="proposal-title">{proposal.action?.data?.message || 'Unknown proposal'}</div>
          <div class="proposal-status" class:approved={voteInfo.status === 'APPROVED'}>
            {voteInfo.status}
          </div>
        </div>

        <div class="proposal-meta">
          <span>By: {proposal.proposer || 'Unknown'}</span>
        </div>

        <div class="voting-info">
          <div class="vote-counts">
            <span class="vote-yes">✅ {voteInfo.yesCount} yes</span>
            <span class="vote-no">❌ {voteInfo.noCount} no</span>
            <span class="vote-abstain">⚪ {voteInfo.abstainCount} abstain</span>
          </div>

          <div class="threshold-info">
            <span>Voting Power: {voteInfo.yesVotingPower}/{voteInfo.threshold}</span>
            {#if voteInfo.status === 'PENDING'}
              <span class="needs-votes">({voteInfo.threshold - voteInfo.yesVotingPower} more needed)</span>
            {/if}
          </div>
        </div>

        {#if voteInfo.votes.length > 0}
          <div class="vote-details">
            {#each voteInfo.votes as [voter, voteData]}
              {@const choice = getVoteChoice(voteData)}
              <div class="vote-item">
                <span class="voter">{voter}:</span>
                <span class="choice" class:yes={choice === 'yes'}
                      class:no={choice === 'no'}
                      class:abstain={choice === 'abstain'}>
                  {choice.toUpperCase()}
                </span>
                {#if typeof voteData === 'object' && voteData.comment}
                  <span class="vote-comment">"{voteData.comment}"</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {:else}
    <div class="empty-state">- no proposals</div>
  {/if}
</div>

<style>
  .scrollable-component {
    height: 25vh;
    overflow-y: auto;
    padding: 8px;
  }

  .scrollable-component::-webkit-scrollbar {
    width: 6px;
  }

  .scrollable-component::-webkit-scrollbar-track {
    background: #1e1e1e;
  }

  .scrollable-component::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }

  .proposal-item {
    background: #2d2d2d;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 8px;
    border-left: 3px solid #7c3aed;
  }

  .proposal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .proposal-title {
    font-weight: 500;
    color: #d4d4d4;
    font-size: 0.85em;
    flex: 1;
  }

  .proposal-status {
    background: #fbbf24;
    color: #000;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.7em;
    font-weight: bold;
  }

  .proposal-status.approved {
    background: #10b981;
    color: white;
  }

  .proposal-meta {
    font-size: 0.75em;
    color: #9d9d9d;
    margin-bottom: 8px;
  }

  .voting-info {
    background: #1e1e1e;
    padding: 8px;
    border-radius: 4px;
    margin-bottom: 8px;
  }

  .vote-counts {
    display: flex;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 0.75em;
  }

  .vote-yes { color: #10b981; }
  .vote-no { color: #ef4444; }
  .vote-abstain { color: #6b7280; }

  .threshold-info {
    font-size: 0.75em;
    color: #d4d4d4;
  }

  .needs-votes {
    color: #fbbf24;
    font-style: italic;
  }

  .vote-details {
    border-top: 1px solid #404040;
    padding-top: 8px;
  }

  .vote-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.7em;
    margin-bottom: 2px;
  }

  .voter {
    color: #9d9d9d;
  }

  .choice {
    font-weight: bold;
  }

  .choice.yes { color: #10b981; }
  .choice.no { color: #ef4444; }
  .choice.abstain { color: #6b7280; }

  .vote-comment {
    color: #9d9d9d;
    font-style: italic;
    margin-left: 8px;
    font-size: 0.9em;
  }
</style>
