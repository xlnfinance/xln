import { EntityTx } from './types';

/**
 * Activates the dormant orderbook by generating place_order transactions
 * The orderbook exists complete but waits for its first order to initialize
 */
export function createPlaceOrderTx(
  from: string,
  side: 'buy' | 'sell',
  price: number,
  quantity: number,
  symbol: string = 'XLN/USDC'
): EntityTx {
  return {
    type: 'place_order',
    data: {
      from,
      symbol,
      side,
      price,
      quantity,
      orderType: 'limit'
    }
  };
}

/**
 * Creates a market maker that sends orders at regular intervals
 */
export function* marketMakerOrders(entityId: string, basePrice: number = 100) {
  let orderCount = 0;

  while (true) {
    // Create bid/ask spread around base price
    const spread = 0.02; // 2% spread
    const bidPrice = Math.floor(basePrice * (1 - spread/2) * 100); // Convert to cents
    const askPrice = Math.floor(basePrice * (1 + spread/2) * 100);

    // Alternate between buy and sell orders
    if (orderCount % 2 === 0) {
      yield createPlaceOrderTx(entityId, 'buy', bidPrice, 10, 'XLN/USDC');
    } else {
      yield createPlaceOrderTx(entityId, 'sell', askPrice, 10, 'XLN/USDC');
    }

    orderCount++;

    // Vary base price slightly
    basePrice = basePrice * (0.98 + Math.random() * 0.04); // ±2% random walk
  }
}

/**
 * Creates a simple test order for immediate orderbook activation
 */
export function createTestOrder(from: string = 'alice'): EntityTx {
  return createPlaceOrderTx(from, 'buy', 9900, 100, 'XLN/USDC'); // Buy 100 XLN at $99
}