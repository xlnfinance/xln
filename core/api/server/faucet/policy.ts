import { safeStringify } from '../../../protocol/serialization';
import { parsePositiveDecimal, type PositiveDecimal } from '../../../protocol/boundary/positive-decimal';

type FaucetEnv = Readonly<Record<string, string | undefined>>;

const FAUCET_PATHS = new Set([
  '/api/faucet/erc20',
  '/api/faucet/gas',
  '/api/faucet/reserve',
  '/api/faucet/offchain',
]);

const exceeds = (value: PositiveDecimal, maximum: PositiveDecimal): boolean => {
  const scale = Math.max(value.scale, maximum.scale);
  return value.coefficient * 10n ** BigInt(scale - value.scale)
    > maximum.coefficient * 10n ** BigInt(scale - maximum.scale);
};

const errorResponse = (
  status: number,
  code: string,
  error: string,
  headers: HeadersInit,
): Response =>
  new Response(safeStringify({ ok: false, code, error }), {
    status,
    headers,
  });

const maximumFor = (pathname: string, env: FaucetEnv): string =>
  pathname === '/api/faucet/gas'
    ? env['XLN_FAUCET_MAX_GAS_AMOUNT'] ?? '0.1'
    : env['XLN_FAUCET_MAX_AMOUNT'] ?? '100';

/** Public faucet access is deployment opt-in and capped; trusted local operators are not public callers. */
export const enforceFaucetPolicy = async (
  request: Request,
  operatorAuthorized: boolean,
  env: FaucetEnv = process.env,
  headers: HeadersInit = { 'content-type': 'application/json' },
): Promise<Response | null> => {
  const pathname = new URL(request.url).pathname;
  if (request.method !== 'POST' || !FAUCET_PATHS.has(pathname)) return null;
  if (!operatorAuthorized && env['XLN_PUBLIC_FAUCET'] !== '1') {
    return errorResponse(404, 'PUBLIC_FAUCET_DISABLED', 'Not found', headers);
  }
  if (operatorAuthorized) return null;

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return errorResponse(400, 'FAUCET_AMOUNT_INVALID', 'Faucet amount must be a positive decimal', headers);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(400, 'FAUCET_AMOUNT_INVALID', 'Faucet amount must be a positive decimal', headers);
  }
  const amount = parsePositiveDecimal(
    (body as Record<string, unknown>)['amount'] ?? (pathname === '/api/faucet/gas' ? '0.1' : '100'),
  );
  if (!amount) {
    return errorResponse(400, 'FAUCET_AMOUNT_INVALID', 'Faucet amount must be a positive decimal', headers);
  }
  const maximumText = maximumFor(pathname, env);
  const maximum = parsePositiveDecimal(maximumText);
  if (!maximum) {
    return errorResponse(500, 'FAUCET_CAP_INVALID', 'Faucet request cap is misconfigured', headers);
  }
  return exceeds(amount, maximum)
    ? errorResponse(413, 'FAUCET_AMOUNT_EXCEEDS_CAP', `Faucet amount exceeds the ${maximumText} request cap`, headers)
    : null;
};
