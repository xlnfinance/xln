#!/usr/bin/env bun
/**
 * Market Maker Bot - Brings the orderbook to life!
 * Creates continuous trading activity with realistic bid/ask spreads
 */

import { createPlaceOrderTx, marketMakerOrders } from './activate-orderbook';
import { EntityInput, Env } from './types';
import { log } from './utils';

interface MarketMakerConfig {
  entityId: string;
  basePrice: number;
  spread: number;        // Percentage spread (e.g., 0.02 = 2%)
  orderSize: number;     // Base order size
  priceWalk: number;     // Price random walk factor (e.g., 0.02 = ±2%)
  intervalMs: number;    // Milliseconds between orders
  maxOrders?: number;    // Optional limit on number of orders
}

class MarketMakerBot {
  private config: MarketMakerConfig;
  private orderGenerator: Generator<any>;
  private orderCount = 0;
  private running = false;
  private currentPrice: number;

  constructor(config: MarketMakerConfig) {
    this.config = config;
    this.currentPrice = config.basePrice;
    this.orderGenerator = marketMakerOrders(config.entityId, config.basePrice);
  }

  /**
   * Start the market maker
   */
  async start(env: Env) {
    if (this.running) {
      log.warn('Market maker already running');
      return;
    }

    this.running = true;
    log.info(`🤖 Market Maker Bot Starting:`);
    log.info(`  Entity: ${this.config.entityId.slice(0, 10)}...`);
    log.info(`  Base Price: $${this.config.basePrice}`);
    log.info(`  Spread: ${(this.config.spread * 100).toFixed(1)}%`);
    log.info(`  Order Interval: ${this.config.intervalMs}ms`);

    while (this.running) {
      if (this.config.maxOrders && this.orderCount >= this.config.maxOrders) {
        log.info(`📊 Max orders reached (${this.config.maxOrders}). Stopping.`);
        break;
      }

      await this.placeNextOrder(env);
      await this.sleep(this.config.intervalMs);
    }

    log.info('🛑 Market Maker Bot Stopped');
  }

  /**
   * Stop the market maker
   */
  stop() {
    this.running = false;
  }

  /**
   * Place the next order
   */
  private async placeNextOrder(env: Env) {
    // Update price with random walk
    const priceChange = 1 + (Math.random() - 0.5) * this.config.priceWalk;
    this.currentPrice *= priceChange;

    // Calculate bid/ask with spread
    const halfSpread = this.config.spread / 2;
    const bidPrice = Math.floor(this.currentPrice * (1 - halfSpread) * 100); // Convert to cents
    const askPrice = Math.floor(this.currentPrice * (1 + halfSpread) * 100);

    // Vary order size slightly (±20%)
    const sizeVariation = 0.8 + Math.random() * 0.4;
    const orderSize = Math.floor(this.config.orderSize * sizeVariation);

    // Place both bid and ask orders
    const bidOrder = createPlaceOrderTx(
      this.config.entityId,
      'buy',
      bidPrice,
      orderSize,
      'XLN/USDC'
    );

    const askOrder = createPlaceOrderTx(
      this.config.entityId,
      'sell',
      askPrice,
      orderSize,
      'XLN/USDC'
    );

    // Create entity inputs
    const bidInput: EntityInput = {
      entityId: this.config.entityId,
      signerId: 'market-maker',
      entityTxs: [bidOrder],
    };

    const askInput: EntityInput = {
      entityId: this.config.entityId,
      signerId: 'market-maker',
      entityTxs: [askOrder],
    };

    // Add to server input queue
    env.serverInput.entityInputs.push(bidInput, askInput);

    this.orderCount += 2;

    log.info(`📈 Order ${this.orderCount - 1}: BUY ${orderSize} @ $${(bidPrice / 100).toFixed(2)}`);
    log.info(`📉 Order ${this.orderCount}: SELL ${orderSize} @ $${(askPrice / 100).toFixed(2)}`);
    log.info(`  Mid: $${this.currentPrice.toFixed(2)} | Spread: $${((askPrice - bidPrice) / 100).toFixed(2)}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get bot statistics
   */
  getStats() {
    return {
      ordersPlaced: this.orderCount,
      currentPrice: this.currentPrice,
      running: this.running,
      config: this.config,
    };
  }
}

/**
 * Create and run a simple market maker demo
 */
export async function runMarketMakerDemo(env: Env) {
  const config: MarketMakerConfig = {
    entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    basePrice: 100,      // Start at $100
    spread: 0.02,        // 2% bid-ask spread
    orderSize: 10,       // 10 units per order
    priceWalk: 0.02,     // ±2% price movement
    intervalMs: 1000,    // 1 order per second
    maxOrders: 20,       // Stop after 20 orders for demo
  };

  const bot = new MarketMakerBot(config);

  // Run in background
  bot.start(env).catch(console.error);

  return bot;
}

// Export the bot class for use elsewhere
export { MarketMakerBot };

// If run directly, show usage
if (import.meta.main) {
  console.log('🤖 Market Maker Bot');
  console.log('This bot creates continuous trading activity in the orderbook.');
  console.log('\nTo use in your code:');
  console.log('  import { MarketMakerBot } from "./market-maker-bot";');
  console.log('  const bot = new MarketMakerBot(config);');
  console.log('  await bot.start(env);');
  console.log('\nOr for a quick demo:');
  console.log('  import { runMarketMakerDemo } from "./market-maker-bot";');
  console.log('  const bot = await runMarketMakerDemo(env);');
}