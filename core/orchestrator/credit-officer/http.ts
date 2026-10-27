import { safeStringify } from '../../protocol/serialization';
import { creditDay, decodeCreditRequest } from './proof';
import { creditDifficulty, creditUsd } from './policy';
import type { CreditOfficer } from './officer';

export function creditOfficerHttp(officer: CreditOfficer, hubIds: ReadonlySet<string>) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/credit-officer/status' && request.method === 'GET') {
        return Response.json({ success: true, enabled: true, hubs: [...hubIds] }, { headers });
      }
      if (url.pathname === '/api/credit-officer/challenge' && request.method === 'GET') {
        const r = decodeCreditRequest({
          ...Object.fromEntries(url.searchParams),
          tokenId: Number(url.searchParams.get('tokenId')),
          day: creditDay(Date.now()),
          nonce: '0',
        });
        if (!hubIds.has(r.hubEntityId)) throw new Error('WRONG_HUB');
        return Response.json(
          { success: true, day: r.day, bits: creditDifficulty(creditUsd(r.tokenId, BigInt(r.amount))) },
          { headers },
        );
      }
      if (url.pathname === '/api/credit-officer/approve' && request.method === 'POST') {
        const result = await officer.decide(await request.json());
        return Response.json(result, { headers });
      }
      return Response.json({ success: false, error: 'NOT_FOUND' }, { status: 404, headers });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.error(safeStringify({ creditOfficer: 'denied', path: new URL(request.url).pathname, error }));
      return Response.json({ success: false, approved: false, error }, { status: 400, headers });
    }
  };
}
