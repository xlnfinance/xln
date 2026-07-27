import type { JurisdictionConfig } from '@xln/runtime/xln-api';
import { errorLog } from './errorLogStore';
import {
  type FaucetResult,
  type HealthMachine,
  type HealthPayload,
  type JurisdictionsPayload,
  type Runtime,
} from './vault-recovery';

export const summarizeHealth = (payload: HealthPayload | null): Record<string, unknown> => {
  if (!payload) return {};
  return {
    timestamp: payload.timestamp,
    resetInProgress: payload?.reset?.inProgress ?? null,
    resetError: payload?.reset?.lastError ?? null,
    system: payload?.system ?? null,
    jMachines: Array.isArray(payload?.jMachines)
      ? payload.jMachines.map((j: HealthMachine) => ({
          name: j?.name,
          status: j?.status,
          chainId: j?.chainId,
          lastBlock: j?.lastBlock,
        }))
      : [],
  };
};

export const resolveJurisdictionChainId = (config: JurisdictionConfig, context: string): number => {
  const chainId = Number(config.chainId || 31337);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`[${context}] CHAIN_ID_INVALID: ${String(config.chainId)}`);
  }
  return Math.floor(chainId);
};

export const fetchJurisdictions = async (baseOrigin?: string): Promise<JurisdictionsPayload> => {
  const primaryOrigin = baseOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance');
  const configuredApiBase =
    typeof window !== 'undefined'
      ? (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__?.trim() || null
      : null;
  const bust = `ts=${Date.now()}`;
  const candidates = configuredApiBase
    ? Array.from(
        new Set([`${configuredApiBase}/api/jurisdictions?${bust}`, `${primaryOrigin}/api/jurisdictions?${bust}`]),
      )
    : [`${primaryOrigin}/api/jurisdictions?${bust}`];

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        cache: 'no-store',
        headers: {
          'cache-control': 'no-cache, no-store, must-revalidate',
          pragma: 'no-cache',
        },
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const payload = (await resp.json()) as JurisdictionsPayload;
      return payload;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Failed to fetch /api/jurisdictions');
};

export async function fundSignerWalletViaFaucet(address: string): Promise<void> {
  try {
    // Call testnet faucet API (Faucet A - ERC20 to wallet)
    const apiBase = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
    const response = await fetch(`${apiBase}/api/faucet/erc20`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress: address,
        tokenSymbol: 'USDC',
        amount: '100',
      }),
    });

    const raw = await response.text();
    let result: FaucetResult | null = null;
    if (raw) {
      try {
        result = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }

    if (!response.ok) {
      const errorMsg = result?.error || `Faucet failed (${response.status})`;
      errorLog.log('Faucet failed', 'Runtime Funding', { address, error: errorMsg });
      return;
    }

    if (!result?.success) {
      errorLog.log('Faucet failed', 'Runtime Funding', { address, error: result?.error || 'Unknown faucet error' });
    }
  } catch (err) {
    errorLog.log('Failed to call faucet', 'Runtime Funding', { address, error: err });
  }
}

export async function fundRuntimeSignersInBrowserVM(runtime: Runtime | null): Promise<void> {
  if (!runtime) return;
  for (const signer of runtime.signers) {
    await fundSignerWalletViaFaucet(signer.address);
  }
}
