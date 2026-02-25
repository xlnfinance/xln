<script lang="ts">
  import { getXLN, xlnEnvironment, xlnFunctions, error } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  const contextIsLive = entityEnv?.isLive;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;
  $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

  export let entityId: string;
  export let signerId: string | null = null;
  export let counterpartyId: string | null;
  export let accountIds: string[] = [];

  let selectedCounterparty = counterpartyId || '';
  let selectedTokenId = 1;
  let collateralAmount = 0n;

  $: effectiveCounterparty = counterpartyId || selectedCounterparty;
  $: tokenList = [1, 2, 3].map(id => {
    const info = activeXlnFunctions?.getTokenInfo?.(id);
    return { id, symbol: info?.symbol || `TKN${id}` };
  });
  $: selectedTokenDecimals = (() => {
    const info = activeXlnFunctions?.getTokenInfo?.(selectedTokenId);
    const decimals = Number(info?.decimals);
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
  })();

  function normalizeEntityId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  function parseBigIntSafe(value: unknown, fallback = 0n): bigint {
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
      if (typeof value === 'string' && value.trim()) return BigInt(value.trim());
      return fallback;
    } catch {
      return fallback;
    }
  }

  function isRuntimeEnv(value: unknown): value is { eReplicas: Map<string, unknown>; jReplicas: Map<string, unknown> } {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function resolveCounterpartyPolicy(env: any, ownerEntityId: string, cpEntityId: string): {
    policyVersion: number;
    baseFee: bigint;
    liquidityFeeBps: bigint;
    gasFee: bigint;
  } | null {
    const ownerNorm = normalizeEntityId(ownerEntityId);
    const cpNorm = normalizeEntityId(cpEntityId);
    if (!ownerNorm || !cpNorm) return null;

    const replicas: Map<string, any> | null = env?.eReplicas instanceof Map ? env.eReplicas : null;
    if (replicas) {
      // 1) Prefer account-learned counterparty policy (most specific).
      for (const [key, replica] of replicas.entries()) {
        const [replicaEntityId] = String(key).split(':');
        if (normalizeEntityId(replicaEntityId) !== ownerNorm) continue;
        const accounts: Map<string, any> | undefined = replica?.state?.accounts;
        if (!(accounts instanceof Map)) break;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) !== cpNorm) continue;
          const policy = account?.counterpartyRebalanceFeePolicy;
          const policyVersion = Number(policy?.policyVersion ?? 0);
          if (Number.isFinite(policyVersion) && policyVersion > 0) {
            return {
              policyVersion,
              baseFee: parseBigIntSafe(policy?.baseFee, 0n),
              liquidityFeeBps: parseBigIntSafe(policy?.liquidityFeeBps, 0n),
              gasFee: parseBigIntSafe(policy?.gasFee, 0n),
            };
          }
        }
      }

      // 2) Fallback to counterparty hub config from replica state.
      for (const [key, replica] of replicas.entries()) {
        const [replicaEntityId] = String(key).split(':');
        if (normalizeEntityId(replicaEntityId) !== cpNorm) continue;
        const cfg = replica?.state?.hubRebalanceConfig;
        const policyVersion = Number(cfg?.policyVersion ?? 0);
        if (!Number.isFinite(policyVersion) || policyVersion <= 0) break;
        return {
          policyVersion,
          baseFee: parseBigIntSafe(cfg?.rebalanceBaseFee ?? cfg?.baseFee, 0n),
          liquidityFeeBps: parseBigIntSafe(cfg?.rebalanceLiquidityFeeBps ?? cfg?.minFeeBps, 0n),
          gasFee: parseBigIntSafe(cfg?.rebalanceGasFee, 0n),
        };
      }
    }

    // 3) Last fallback: gossip metadata.
    const profiles = env?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => normalizeEntityId(p?.entityId) === cpNorm);
    const md = profile?.metadata || {};
    const policyVersion = Number(md?.policyVersion ?? 0);
    if (!Number.isFinite(policyVersion) || policyVersion <= 0) return null;
    return {
      policyVersion,
      baseFee: parseBigIntSafe(md?.rebalanceBaseFee ?? md?.baseFee, 0n),
      liquidityFeeBps: parseBigIntSafe(md?.rebalanceLiquidityFeeBps ?? md?.minFeeBps, 0n),
      gasFee: parseBigIntSafe(md?.rebalanceGasFee, 0n),
    };
  }

  async function requestCollateral() {
    if (!effectiveCounterparty) return;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Collateral request is only available in LIVE mode');
      const resolvedSigner = activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'collateral-form')
        || signerId
        || requireSignerIdForEntity(env, entityId, 'collateral-form');
      const feePolicy = resolveCounterpartyPolicy(env, entityId, effectiveCounterparty);
      if (!feePolicy) {
        throw new Error('Missing counterparty rebalance fee policy. Sync gossip/profile first.');
      }
      if (feePolicy.baseFee < 0n || feePolicy.gasFee < 0n || feePolicy.liquidityFeeBps < 0n) {
        throw new Error('Counterparty rebalance fee policy contains negative values.');
      }
      const feeAmount =
        feePolicy.baseFee +
        feePolicy.gasFee +
        ((collateralAmount * feePolicy.liquidityFeeBps) / 10000n);
      if (feeAmount < 0n) {
        throw new Error('Computed rebalance fee is negative. Counterparty policy is invalid.');
      }

      const collateralInput = {
        entityId,
        signerId: resolvedSigner,
        entityTxs: [{
          type: 'requestCollateral' as const,
          data: {
            counterpartyEntityId: effectiveCounterparty,
            tokenId: selectedTokenId,
            amount: collateralAmount,
            feeAmount,
            policyVersion: feePolicy.policyVersion
          }
        }]
      };

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [collateralInput] });
      console.log(`Collateral requested: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, collateralAmount)}`);

      collateralAmount = 0n;
    } catch (err: any) {
      console.error('Failed to request collateral:', err);
      error.set(`Collateral request failed: ${err?.message || 'Unknown error'}`);
    }
  }
</script>

<div class="action-card">
  <h4>Request Collateral</h4>
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
      bind:value={collateralAmount}
      decimals={selectedTokenDecimals}
      placeholder="Collateral amount"
    />
    <button class="action-button collateral" on:click={requestCollateral} disabled={!effectiveCounterparty || collateralAmount <= 0n}>
      Request Collateral
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

  .action-button.collateral {
    background: linear-gradient(135deg, #0d9488, #0f766e);
    color: white;
    box-shadow: 0 1px 3px rgba(13, 148, 136, 0.3);
  }

  .action-button.collateral:hover {
    background: linear-gradient(135deg, #14b8a6, #0d9488);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
