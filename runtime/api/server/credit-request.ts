import type { AccountState } from '../../types/account';
import type { RuntimeInput, RuntimeReplica } from '../../runtime/types';
import { safeStringify } from '../../protocol/serialization';
import { resolveEntityProposerId } from '../../runtime/entity-output-signer';
import { getAccountState, getEntityOutCapacity, hasAccount } from './entity-lookup';
import { getFaucetHubProfiles } from './faucet-hubs';
import { getRequestCreditCap } from './hub-health';
import { isEntityId32 } from './utils';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from '../../runtime/ingress-receipts';
import { withRuntimeCommittedRead } from '../../runtime/frame/writer-lock';

type CreditRequestInput = {
  req: Request;
  env: RuntimeReplica | null;
  headers: HeadersInit;
  activeHubEntityIds: string[];
  enqueueRuntimeInput: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  validateRuntimeInputAdmission: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  registerReceipt: (receipt: RegisterReceiptOptions) => RuntimeIngressReceipt;
  getCurrentRuntimeHeight: (env: RuntimeReplica | null) => number;
  buildRuntimeInputStatusUrl: (id: string) => string;
};

type ParsedCreditRequest = {
  userEntityId: string;
  hubEntityId: string;
  tokenId: number;
  requestedAmount: bigint;
};

type AdmittedCreditRequest = ParsedCreditRequest & {
  account: AccountState;
  approvedAmount: bigint;
};

const json = (
  headers: HeadersInit,
  body: Record<string, unknown>,
  status = 200,
): Response => new Response(safeStringify(body), { status, headers });

const parseCreditRequest = async (
  req: Request,
  headers: HeadersInit,
): Promise<ParsedCreditRequest | Response> => {
  const body: unknown = await req.json();
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const userEntityId = typeof value['userEntityId'] === 'string' ? value['userEntityId'].toLowerCase() : '';
  const hubEntityId = typeof value['hubEntityId'] === 'string' ? value['hubEntityId'].toLowerCase() : '';
  const tokenId = Number(value['tokenId'] ?? 1);
  const amount = typeof value['amount'] === 'string' ? value['amount'].trim() : '';
  if (!isEntityId32(userEntityId)) return json(headers, { error: 'Invalid userEntityId' }, 400);
  if (!isEntityId32(hubEntityId)) return json(headers, { error: 'Invalid hubEntityId' }, 400);
  if (!/^\d+$/.test(amount)) return json(headers, { error: 'Invalid amount' }, 400);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    return json(headers, { error: 'Invalid tokenId' }, 400);
  }
  const requestedAmount = BigInt(amount);
  if (requestedAmount <= 0n) return json(headers, { error: 'Amount must be positive' }, 400);
  return { userEntityId, hubEntityId, tokenId, requestedAmount };
};

const admitCreditRequest = (
  env: RuntimeReplica,
  request: ParsedCreditRequest,
  activeHubEntityIds: string[],
  headers: HeadersInit,
): AdmittedCreditRequest | Response => {
  const hubs = getFaucetHubProfiles(env, activeHubEntityIds);
  const hub = hubs.find(profile => profile.entityId.toLowerCase() === request.hubEntityId);
  if (!hub) {
    return json(headers, {
      error: 'Requested hub is not available',
      knownHubEntityIds: hubs.map(profile => profile.entityId),
    }, 404);
  }
  const account = getAccountState(env, hub.entityId, request.userEntityId);
  if (!account || !hasAccount(env, hub.entityId, request.userEntityId)) {
    return json(headers, {
      error: 'No bilateral account with selected hub. Open account first.',
      hubEntityId: hub.entityId,
      userEntityId: request.userEntityId,
    }, 409);
  }
  const cap = getRequestCreditCap(request.tokenId);
  return {
    ...request,
    hubEntityId: hub.entityId,
    account,
    approvedAmount: request.requestedAmount > cap ? cap : request.requestedAmount,
  };
};

const alreadySatisfied = (
  input: CreditRequestInput,
  env: RuntimeReplica,
  request: AdmittedCreditRequest,
): Response | null => {
  const capacity = getEntityOutCapacity(request.account, request.hubEntityId, request.tokenId);
  if (capacity < request.approvedAmount) return null;
  return json(input.headers, {
    success: true,
    status: 'already_satisfied',
    runtimeId: typeof env.runtimeId === 'string' ? env.runtimeId : null,
    currentHeight: input.getCurrentRuntimeHeight(env),
    hubEntityId: request.hubEntityId,
    userEntityId: request.userEntityId,
    tokenId: request.tokenId,
    approvedAmount: capacity.toString(),
  });
};

const buildCreditRuntimeInput = (
  request: AdmittedCreditRequest,
  signerId: string,
): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId: request.hubEntityId,
    signerId,
    entityTxs: [{
      type: 'extendCredit',
      data: {
        counterpartyEntityId: request.userEntityId,
        tokenId: request.tokenId,
        amount: request.approvedAmount,
      },
    }],
  }],
});

const resolveHubSigner = (
  env: RuntimeReplica,
  hubEntityId: string,
  headers: HeadersInit,
): string | Response => {
  try {
    return resolveEntityProposerId(env, hubEntityId, 'credit-request');
  } catch (error) {
    return json(headers, {
      error: error instanceof Error ? error.message : 'Hub signer unavailable',
    }, 503);
  }
};

const queueCreditRequest = (
  input: CreditRequestInput,
  env: RuntimeReplica,
  request: AdmittedCreditRequest,
  runtimeInput: RuntimeInput,
): Response => {
  const requestId = `credit_${globalThis.crypto.randomUUID()}`;
  let receipt: RuntimeIngressReceipt;
  try {
    input.validateRuntimeInputAdmission(env, runtimeInput);
    input.enqueueRuntimeInput(env, runtimeInput);
    receipt = input.registerReceipt({
      id: requestId,
      kind: 'credit-request',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: input.getCurrentRuntimeHeight(env),
      runtimeInput,
      note: 'Credit request was accepted into the hub runtime queue; poll statusUrl and account state for settlement.',
    });
  } catch (error) {
    return json(input.headers, {
      error: 'Failed to admit credit request into runtime',
      code: 'CREDIT_REQUEST_ADMISSION_FAILED',
      details: error instanceof Error ? error.message : String(error),
    }, 503);
  }
  return json(input.headers, {
    success: true,
    status: 'queued',
    requestId,
    receipt,
    statusUrl: input.buildRuntimeInputStatusUrl(receipt.id),
    runtimeId: typeof env.runtimeId === 'string' ? env.runtimeId : null,
    currentHeight: input.getCurrentRuntimeHeight(env),
    hubEntityId: request.hubEntityId,
    userEntityId: request.userEntityId,
    tokenId: request.tokenId,
    approvedAmount: request.approvedAmount.toString(),
  });
};

export const handleCreditRequest = async (input: CreditRequestInput): Promise<Response> => {
  try {
    const env = input.env;
    if (!env) return json(input.headers, { error: 'Runtime not initialized' }, 503);
    const parsed = await parseCreditRequest(input.req, input.headers);
    if (parsed instanceof Response) return parsed;
    return await withRuntimeCommittedRead(env, () => {
      const admitted = admitCreditRequest(
        env,
        parsed,
        input.activeHubEntityIds,
        input.headers,
      );
      if (admitted instanceof Response) return admitted;
      const satisfied = alreadySatisfied(input, env, admitted);
      if (satisfied) return satisfied;
      const signerId = resolveHubSigner(
        env,
        admitted.hubEntityId,
        input.headers,
      );
      if (signerId instanceof Response) return signerId;
      return queueCreditRequest(
        input,
        env,
        admitted,
        buildCreditRuntimeInput(admitted, signerId),
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(input.headers, { error: message }, 500);
  }
};
