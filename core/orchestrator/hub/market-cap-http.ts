import type { MarketCapController } from '../../network/relay/market/cap/market-cap-controller';
import { safeStringify } from '../../protocol/serialization';

type JsonHeaders = Readonly<Record<string, string>>;

export const handleMarketCapRequest = async (input: Readonly<{
  url: URL;
  headers: JsonHeaders;
  controller: MarketCapController;
  report(level: 'warn' | 'error', reason: string, message: string): void;
}>): Promise<Response> => {
  try {
    return new Response(safeStringify(await input.controller.handle(input.url)), { headers: input.headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const badQuery = message.startsWith('MARKET_CAP_QUERY_');
    input.report(
      badQuery ? 'warn' : 'error',
      badQuery ? 'MARKET_CAP_QUERY_REJECTED' : 'MARKET_CAP_REFRESH_FAILED',
      message,
    );
    return new Response(safeStringify({ error: message }), {
      status: badQuery ? 400 : 503,
      headers: input.headers,
    });
  }
};
