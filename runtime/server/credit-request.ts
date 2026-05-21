import type { Env, RuntimeInput } from '../types';
import { safeStringify } from '../serialization-utils';
import { resolveEntityProposerId } from '../state-helpers';
import { getAccountMachine, getEntityOutCapacity, hasAccount } from './entity-lookup';
import { getFaucetHubProfiles } from './faucet-hubs';
import { getRequestCreditCap } from './hub-health';
import { isEntityId32 } from '../server-utils';

export const handleCreditRequest = async (input: {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  activeHubEntityIds: string[];
  enqueueRuntimeInput: (env: Env, runtimeInput: RuntimeInput) => void;
}): Promise<Response> => {
  const { req, env, headers } = input;
  try {
    if (!env) {
      return new Response(safeStringify({ error: 'Runtime not initialized' }), { status: 503, headers });
    }

    const body = await req.json();
    const userEntityId = typeof body?.userEntityId === 'string' ? body.userEntityId.toLowerCase() : '';
    const requestedHubEntityId = typeof body?.hubEntityId === 'string' ? body.hubEntityId.toLowerCase() : '';
    const tokenId = Number(body?.tokenId ?? 1);
    const amountRaw = typeof body?.amount === 'string' ? body.amount.trim() : '';

    if (!isEntityId32(userEntityId)) {
      return new Response(safeStringify({ error: 'Invalid userEntityId' }), { status: 400, headers });
    }
    if (!isEntityId32(requestedHubEntityId)) {
      return new Response(safeStringify({ error: 'Invalid hubEntityId' }), { status: 400, headers });
    }
    if (!/^\d+$/.test(amountRaw)) {
      return new Response(safeStringify({ error: 'Invalid amount' }), { status: 400, headers });
    }
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return new Response(safeStringify({ error: 'Invalid tokenId' }), { status: 400, headers });
    }

    const hubs = getFaucetHubProfiles(env, input.activeHubEntityIds);
    const hubProfile = hubs.find((profile) => profile.entityId.toLowerCase() === requestedHubEntityId);
    if (!hubProfile) {
      return new Response(
        JSON.stringify({
          error: 'Requested hub is not available',
          knownHubEntityIds: hubs.map((profile) => profile.entityId),
        }),
        { status: 404, headers },
      );
    }

    const hubEntityId = hubProfile.entityId;
    const accountMachine = getAccountMachine(env, hubEntityId, userEntityId);
    if (!accountMachine || !hasAccount(env, hubEntityId, userEntityId)) {
      return new Response(
        JSON.stringify({
          error: 'No bilateral account with selected hub. Open account first.',
          hubEntityId,
          userEntityId,
        }),
        { status: 409, headers },
      );
    }

    const requestedAmount = BigInt(amountRaw);
    if (requestedAmount <= 0n) {
      return new Response(safeStringify({ error: 'Amount must be positive' }), { status: 400, headers });
    }

    const approvedAmount = requestedAmount > getRequestCreditCap(tokenId)
      ? getRequestCreditCap(tokenId)
      : requestedAmount;
    const currentOutCapacity = getEntityOutCapacity(accountMachine, hubEntityId, tokenId);
    if (currentOutCapacity >= approvedAmount) {
      return new Response(
        JSON.stringify({
          success: true,
          hubEntityId,
          userEntityId,
          tokenId,
          approvedAmount: currentOutCapacity.toString(),
        }),
        { status: 200, headers },
      );
    }

    let hubSignerId: string;
    try {
      hubSignerId = resolveEntityProposerId(env, hubEntityId, 'credit-request');
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Hub signer unavailable' }),
        { status: 503, headers },
      );
    }

    input.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: hubEntityId,
          signerId: hubSignerId,
          entityTxs: [
            {
              type: 'extendCredit',
              data: {
                counterpartyEntityId: userEntityId,
                tokenId,
                amount: approvedAmount,
              },
            },
          ],
        },
      ],
    });

    return new Response(
      JSON.stringify({
        success: true,
        hubEntityId,
        userEntityId,
        tokenId,
        approvedAmount: approvedAmount.toString(),
      }),
      { status: 200, headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(safeStringify({ error: message }), { status: 500, headers });
  }
};
