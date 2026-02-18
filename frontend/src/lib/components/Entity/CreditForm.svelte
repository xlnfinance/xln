<script lang="ts">
  import { getXLN, xlnEnvironment, xlnFunctions, error } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  export let entityId: string;
  export let signerId: string | null = null;
  export let counterpartyId: string | null;
  export let accountIds: string[] = [];

  let selectedCounterparty = counterpartyId || '';
  let selectedTokenId = 1;
  let creditAmountBigInt = 0n;

  $: effectiveCounterparty = counterpartyId || selectedCounterparty;
  $: tokenList = [1, 2, 3].map(id => {
    const info = activeXlnFunctions?.getTokenInfo?.(id);
    return { id, symbol: info?.symbol || `TKN${id}` };
  });

  async function extendCredit() {
    if (!effectiveCounterparty) return;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env || !('history' in env)) throw new Error('XLN environment not ready or in historical mode');
      const resolvedSigner = activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'credit-form')
        || signerId
        || entityId;

      const adjustmentInput = {
        entityId,
        signerId: resolvedSigner,
        entityTxs: [{
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: effectiveCounterparty,
            tokenId: selectedTokenId,
            amount: creditAmountBigInt
          }
        }]
      };

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [adjustmentInput] });
      console.log(`Credit extended: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, creditAmountBigInt)}`);

      creditAmountBigInt = 0n;
    } catch (err: any) {
      console.error('Failed to extend credit:', err);
      error.set(`Credit extension failed: ${err?.message || 'Unknown error'}`);
    }
  }
</script>

<div class="action-card">
  <h4>Extend Credit</h4>
  <div class="action-form">
    {#if counterpartyId === null}
      <EntitySelect bind:value={selectedCounterparty} options={accountIds} placeholder="Select account" />
    {/if}
    <select bind:value={selectedTokenId} class="form-select">
      {#each tokenList as token}
        <option value={token.id}>{token.symbol}</option>
      {/each}
    </select>
    <BigIntInput
      bind:value={creditAmountBigInt}
      decimals={18}
      placeholder="Credit amount"
    />
    <button class="action-button secondary" on:click={extendCredit} disabled={!effectiveCounterparty || creditAmountBigInt <= 0n}>
      Extend Credit
    </button>
  </div>
</div>

<style>
  .action-card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 10px;
  }

  .action-card h4 {
    margin: 0 0 12px 0;
    color: #e4e4e7;
    font-size: 0.88em;
    font-weight: 600;
  }

  .action-form {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .form-select {
    padding: 9px 10px;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 0.88em;
    min-width: 100px;
  }

  .form-select:focus {
    border-color: #fbbf24;
    outline: none;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.1);
  }

  .action-button {
    padding: 9px 18px;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.82em;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .action-button.secondary {
    background: linear-gradient(135deg, #1e40af, #1e3a8a);
    color: white;
    box-shadow: 0 1px 3px rgba(30, 64, 175, 0.3);
  }

  .action-button.secondary:hover {
    background: linear-gradient(135deg, #2563eb, #1e40af);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
