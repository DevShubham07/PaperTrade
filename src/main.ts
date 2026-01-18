/**
 * Bot Main Entry Point
 * Fetches and displays BTC market data without strategy logic
 */

import { SpotPriceService } from './services/spotPriceService';
import { MarketInfoService } from './services/marketInfoService';
import { OrderBookService } from './services/orderBookService';
import { SessionLogger } from './services/sessionLogger';
import { TradeLogger } from './services/tradeLogger';
import { ExecutionGateway } from './execution';
import { ExpirationConvergenceStrategy } from './strategies/ExpirationConvergenceStrategy';
import { HedgeArbitrage49Strategy } from './strategies/HedgeArbitrage49Strategy';
import { CONFIG } from './config';

type StrategyLike = {
    isInKillZone: (upAsk: number, upBid: number, downAsk: number, downBid: number) => boolean;
    getSessionState: () => { sessionPnL: number; sessionStartTime: number; isSessionLocked: boolean; lockReason: any; tradesThisSession: number };
    getCircuitBreakerState: () => { isCoolingDown: boolean; crashLowPrice: number; stabilityCounter: number; lastStopLossTime: number; crashTokenId: string; lastTradeTime: number };
    shouldEnterTrade: (
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number,
        currentPrices?: { upAsk: number; upBid: number; downAsk: number; downBid: number }
    ) => { shouldTrade: boolean; direction: 'UP' | 'DOWN' | null; fairValue?: number; volatility?: number };
    executeTrade: (
        marketInfo: any,
        spotPrice: number,
        strikePrice: number,
        direction: 'UP' | 'DOWN',
        fairValue?: number
    ) => Promise<{ buyOrderId: string; sellOrderId: string } | null>;
    updateOrderStatus: (timeRemainingSeconds?: number) => Promise<void>;
    getStats: (currentPrices?: { upBid: number; downBid: number }) => any;
    getTradeRecords: () => any[];
    resetForNewMarket: () => Promise<void>;
};

class TradingBot {
    private spotPriceService: SpotPriceService;
    private marketInfoService: MarketInfoService;
    private orderBookService: OrderBookService;
    private sessionLogger: SessionLogger;
    private tradeLogger: TradeLogger;
    private executionGateway: ExecutionGateway;
    private strategy: StrategyLike;
    private intervalHandle: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private tickCount: number = 0;
    private lastMarketSlug: string | null = null;
    private consecutiveStrikePriceFailures: number = 0;

    constructor() {
        this.spotPriceService = new SpotPriceService();
        this.marketInfoService = new MarketInfoService();
        this.orderBookService = new OrderBookService();
        this.sessionLogger = new SessionLogger('./data');
        this.tradeLogger = new TradeLogger('./logs');
        this.executionGateway = new ExecutionGateway();
        this.strategy = CONFIG.HEDGE_ARBITRAGE_MODE
            ? new HedgeArbitrage49Strategy(this.executionGateway, this.orderBookService)
            : new ExpirationConvergenceStrategy(this.executionGateway, this.orderBookService);

        console.log('');
        console.log('🤖 ════════════════════════════════════════════');
        console.log(`🤖   BOT MODE: ${CONFIG.HEDGE_ARBITRAGE_MODE ? '🧷 HEDGE ARB (BUY BOTH @ 0.49)' : 'SENIOR QUANT v2.1 - SIMPLIFIED SCALPER'}`);
        console.log('🤖 ════════════════════════════════════════════');
        if (!CONFIG.HEDGE_ARBITRAGE_MODE) {
            console.log(`🤖   Safe Zone: $${CONFIG.MIN_ENTRY_PRICE.toFixed(2)} - $${CONFIG.MAX_ENTRY_PRICE.toFixed(2)}`);
            console.log('🤖   --- FIXED RISK PARAMS ---');
            console.log(`🤖   Profit: +$${CONFIG.FIXED_PROFIT_TARGET.toFixed(2)} | Stop: -$${CONFIG.FIXED_STOP_LOSS.toFixed(2)}`);
            console.log(`🤖   Breakeven at: +$${CONFIG.BREAKEVEN_TRIGGER.toFixed(3)}`);
            console.log('🤖   --- SESSION LIMITS ---');
            console.log(`🤖   Lock at: +$${CONFIG.SESSION_PROFIT_TARGET.toFixed(2)} | Stop at: -$${CONFIG.SESSION_LOSS_LIMIT.toFixed(2)}`);
            console.log('🤖   --- REMOVED IN v2.1 ---');
            console.log('🤖   ❌ Fair value / Z-score | ❌ Trend confirmation');
        } else {
            console.log(`🤖   Entry: Buy UP + DOWN @ $${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)} once per market`);
            console.log(`🤖   Hold: to expiry, then settle for +$0.02 per share pair (if fills at 0.49/0.49)`);
            console.log(`🤖   Rotate: after expiry (MARKET_ROTATION_THRESHOLD=${CONFIG.MARKET_ROTATION_THRESHOLD}s)`);
        }
        console.log('🤖 ════════════════════════════════════════════');
        console.log('');
    }

    /**
     * Main tick - Fetch and display all market data
     */
    private async tick(): Promise<void> {
        try {
            this.tickCount++;
            console.log('');
            console.log(`--- ⏱️ TICK #${this.tickCount} ---`);

            // Get or refresh market info (don't wait for spot price - we can discover markets first)
            let marketInfo = this.marketInfoService.getCurrentMarket();

            if (!marketInfo || this.marketInfoService.isMarketExpiring(CONFIG.MARKET_ROTATION_THRESHOLD)) {
                marketInfo = await this.marketInfoService.getActiveMarket();

                if (!marketInfo) {
                    return;
                }

                // Only print market info if it's a different market
                if (this.lastMarketSlug !== marketInfo.eventSlug) {
                    // End previous session if exists
                    if (this.lastMarketSlug !== null) {
                        console.log('');
                        console.log('🔄 Market rotation detected - cleaning up previous market...');
                        
                        // Check for open positions and handle emergency exit
                        const paperPosition = this.executionGateway.getPaperPosition();
                        if (paperPosition) {
                            console.log(`⚠️ Open position detected - executing emergency exit...`);
                            console.log(`   Position: ${paperPosition.shares.toFixed(4)} shares @ $${paperPosition.entryPrice.toFixed(4)}`);
                            
                            // Try to get current market price for emergency exit
                            try {
                                const oldMarketInfo = this.marketInfoService.getCurrentMarket();
                                if (oldMarketInfo) {
                                    const tokenId = paperPosition.tokenId === oldMarketInfo.upTokenId 
                                        ? oldMarketInfo.upTokenId 
                                        : oldMarketInfo.downTokenId;
                                    const orderBook = await this.orderBookService.getOrderBook(tokenId);
                                    const exitPrice = orderBook.bestBid > 0 ? orderBook.bestBid : 0.50; // Use bid or mid-market
                                    
                                    // Execute emergency sell
                                    const exitSize = paperPosition.shares;
                                    const executed = await this.executionGateway.executeFAK(
                                        tokenId,
                                        'SELL',
                                        exitPrice,
                                        exitSize
                                    );
                                    
                                    if (executed) {
                                        const pnl = (exitPrice - paperPosition.entryPrice) * exitSize;
                                        console.log(`   ✅ Emergency exit @ $${exitPrice.toFixed(4)} | P&L: $${pnl.toFixed(2)}`);
                                    } else {
                                        console.log(`   ⚠️ Emergency exit failed - position will be cleared`);
                                    }
                                }
                            } catch (error) {
                                console.log(`   ⚠️ Could not execute emergency exit: ${error}`);
                            }
                        }
                        
                        // 💾 SAVE DATA BEFORE CLEANUP (CRITICAL - must happen before reset)
                        console.log('💾 Saving session data before market rotation...');
                        
                        // Save session logger data (async - must await)
                        if (this.sessionLogger.isSessionActive()) {
                            try {
                                const savedPath = await this.sessionLogger.endSession();
                                if (savedPath) {
                                    console.log(`   ✅ Session data saved: ${savedPath}`);
                                } else {
                                    console.log(`   ⚠️ Session had no data to save`);
                                }
                            } catch (err) {
                                console.error('   ❌ Error saving session data:', err);
                            }
                        } else {
                            console.log('   ℹ️ No active session to save');
                        }
                        
                        // Save trade logger data (sync - saves immediately)
                        if (this.tradeLogger.isSessionActive()) {
                            try {
                                // For market rotation summary, we use 0 prices as it's settling anyway
                                const stats = this.strategy.getStats();
                                const records = this.strategy.getTradeRecords();
                                const endingCapital = this.executionGateway.getPaperCash();  // 💰 Get current wallet balance
                                this.tradeLogger.endSession(stats, records, endingCapital);
                                console.log(`   ✅ Trade data saved (${records.length} records)`);
                            } catch (err) {
                                console.error('   ❌ Error saving trade data:', err);
                            }
                        } else {
                            console.log('   ℹ️ No active trade session to save');
                        }
                        
                        console.log('✅ All data saved - proceeding with cleanup...');
                        
                        // Reset strategy for new market (this will clear all orders and positions)
                        await this.strategy.resetForNewMarket();
                    }
                    
                    // Start new session for new market
                    this.sessionLogger.startSession(marketInfo.eventSlug);
                    const startingCapital = this.executionGateway.getPaperCash();  // 💰 Record wallet at session start
                    this.tradeLogger.startSession(marketInfo.eventSlug, startingCapital);
                    
                    console.log('');
                    console.log('🎯 ========================================');
                    console.log(`🎯 MARKET: ${marketInfo.eventSlug}`);
                    console.log(`🎯 Strike Price: $${marketInfo.strikePrice.toFixed(2)}`);
                    console.log(`🎯 UP Token:   ${marketInfo.upTokenId.substring(0, 12)}...`);
                    console.log(`🎯 DOWN Token: ${marketInfo.downTokenId.substring(0, 12)}...`);
                    console.log(`🎯 Expires: ${marketInfo.endDate.toLocaleString()}`);
                    console.log('🎯 ========================================');
                    console.log('');
                    this.lastMarketSlug = marketInfo.eventSlug;
                }
            }

            // Fetch current BTC spot price (with fallback if not ready)
            let spotPrice: number;
            try {
                spotPrice = this.spotPriceService.getBTCPrice();
            } catch (error) {
                console.log('⏳ Waiting for spot price service to initialize...');
                return;
            }
            
            const strikePrice = marketInfo.strikePrice;

            // 🛡️ CRITICAL: Wait for strike price to be loaded before trading
            let effectiveStrikePrice = strikePrice;

            if (strikePrice <= 0) {
                // Count consecutive failures to provide better logging
                if (!this.consecutiveStrikePriceFailures) {
                    this.consecutiveStrikePriceFailures = 0;
                }
                this.consecutiveStrikePriceFailures++;

                // Check for manual override first
                if (CONFIG.MANUAL_STRIKE_PRICE && CONFIG.MANUAL_STRIKE_PRICE > 0) {
                    effectiveStrikePrice = CONFIG.MANUAL_STRIKE_PRICE;
                    console.warn(`⚠️ USING MANUAL STRIKE PRICE OVERRIDE: $${effectiveStrikePrice.toFixed(2)}`);
                    console.warn(`   Set MANUAL_STRIKE_PRICE in your .env file to override API failures`);
                    this.consecutiveStrikePriceFailures = 0; // Reset since we have a valid price
                } else {
                    console.log('⏳ Waiting for strike price to be loaded...');
                    console.log(`   Current strike price: $${strikePrice.toFixed(2)} (${this.consecutiveStrikePriceFailures} consecutive failures)`);
                    console.log('💡 This may be due to Chainlink API rate limiting. Bot will keep trying...');
                    console.log('💡 Alternatively, set MANUAL_STRIKE_PRICE in .env to override');

                    // Don't trade without valid strike price - wait indefinitely
                    return; // Skip this tick - keep trying
                }
            } else {
                // Reset failure counter on success
                this.consecutiveStrikePriceFailures = 0;
            }

            const difference = spotPrice - effectiveStrikePrice;

            console.log('📊 SPOT PRICE DATA:');
            console.log(`   BTC Spot Price: $${spotPrice.toFixed(2)}`);
            console.log(`   Strike Price: $${effectiveStrikePrice.toFixed(2)} ${effectiveStrikePrice !== strikePrice ? '(MANUAL OVERRIDE)' : ''}`);
            console.log(`   Difference: $${difference.toFixed(2)} (${difference >= 0 ? '🟢 UP' : '🔴 DOWN'})`);

            // Fetch token prices
            let prices: { upAsk: number; upBid: number; downAsk: number; downBid: number } | null = null;
            try {
                prices = await this.orderBookService.getCurrentPrices(
                    marketInfo.upTokenId,
                    marketInfo.downTokenId
                );

                console.log('');
                console.log('💰 TOKEN PRICES:');
                console.log(`   Price Up:   $${prices.upAsk.toFixed(4)} (Bid: $${prices.upBid.toFixed(4)})`);
                console.log(`   Price Down: $${prices.downAsk.toFixed(4)} (Bid: $${prices.downBid.toFixed(4)})`);

            } catch (error: any) {
                if (error.message && error.message.includes('Order book is empty')) {
                    console.warn('⚠️ Order book is empty. Market may not have liquidity yet.');
                } else {
                    console.error('❌ Error fetching token prices:', error.message);
                }
                // Continue execution even if price fetch fails - we'll still check fills if we have cached prices
            }

            // Show time remaining (seconds)
            const timeRemainingSeconds = this.marketInfoService.getTimeRemaining() * 60;
            console.log('');
            console.log(`⏰ Time Remaining: ${timeRemainingSeconds.toFixed(0)} seconds`);

            // 🛡️ CRITICAL: Update order status FIRST to credit cash and unlock trading
            // Check paper fills for both tokens (even if price fetch failed, use last known prices)
            if (prices) {
                if (prices.upAsk > 0 || prices.upBid > 0) {
                    this.executionGateway.checkPaperFills(
                        marketInfo.upTokenId,
                        prices.upAsk,
                        prices.upBid
                    );
                }
                if (prices.downAsk > 0 || prices.downBid > 0) {
                    this.executionGateway.checkPaperFills(
                        marketInfo.downTokenId,
                        prices.downAsk,
                        prices.downBid
                    );
                }
            } else {
                // Even if we don't have fresh prices, try to check fills with any available data
                // This helps when order book errors occur but we still want to check pending orders
                console.log('⚠️ Skipping fill checks - no price data available');
            }

            // Update order status (check for fills, stop loss, hold to maturity)
            // This credits cash from filled sells and unlocks trading for next trades
            await this.strategy.updateOrderStatus(timeRemainingSeconds);

            // 🛡️ SAFE ZONE CHECK (Senior Quant v1.3): Only trade $0.60-$0.90
            let killZoneActive = false;
            if (prices) {
                killZoneActive = this.strategy.isInKillZone(
                    prices.upAsk,
                    prices.upBid,
                    prices.downAsk,
                    prices.downBid
                );
            }

            // 📈 SESSION STATUS (Senior Quant v2.0)
            const sessionState = this.strategy.getSessionState();
            console.log(`📈 Session P&L: $${sessionState.sessionPnL.toFixed(2)} | Trades: ${sessionState.tradesThisSession}`);
            if (sessionState.isSessionLocked) {
                console.log(`🔒 SESSION LOCKED: ${sessionState.lockReason}`);
            }

            // 🔄 CIRCUIT BREAKER STATUS
            const cbState = this.strategy.getCircuitBreakerState();
            if (cbState.isCoolingDown) {
                console.log(`🔄 CIRCUIT BREAKER: Cooldown ${cbState.stabilityCounter}/${CONFIG.STABILITY_TICKS_REQUIRED} ticks`);
                console.log(`   Crash Low: $${cbState.crashLowPrice.toFixed(4)}`);
            }

            // STRATEGY EXECUTION - Now called AFTER cash is credited and trading is unlocked
            // 🛑 CRITICAL: Pass current prices so the HARD PRICE ENFORCER can check them
            const strategyCheck = this.strategy.shouldEnterTrade(
                spotPrice,
                effectiveStrikePrice,
                timeRemainingSeconds,
                prices || undefined  // Pass prices for hard price filter
            );

            // Final trade decision: strategy + kill zone check
            const shouldTradeFinal = strategyCheck.shouldTrade && !killZoneActive;

            // Log strategy decision
            this.tradeLogger.logDecision(
                spotPrice,
                effectiveStrikePrice,
                timeRemainingSeconds,
                shouldTradeFinal,
                strategyCheck.direction,
                prices ? {
                    upAsk: prices.upAsk,
                    upBid: prices.upBid,
                    downAsk: prices.downAsk,
                    downBid: prices.downBid
                } : undefined,
                strategyCheck.fairValue,
                strategyCheck.volatility
            );

            // Execute trade if conditions are met (strategy OK and not in kill zone)
            if (shouldTradeFinal && strategyCheck.direction) {
                const result = await this.strategy.executeTrade(
                    marketInfo,
                    spotPrice,
                    effectiveStrikePrice,
                    strategyCheck.direction,
                    (strategyCheck as any).fairValue // Pass the calculated fair value
                );

                if (result) {
                    // Log the trade
                    const records = this.strategy.getTradeRecords();
                    const buyRecord = records.find(r => r.orderId === result.buyOrderId);
                    const sellRecord = records.find(r => r.orderId === result.sellOrderId);
                    if (buyRecord) this.tradeLogger.logTrade(buyRecord);
                    if (sellRecord) this.tradeLogger.logTrade(sellRecord);
                }
            }

            // Log current stats (Mark-to-Market)
            const stats = this.strategy.getStats(prices ? { 
                upBid: prices.upBid, 
                downBid: prices.downBid 
            } : undefined);
            this.tradeLogger.logStats(stats);

            // Log tick data to session logger (non-blocking, in-memory only)
            if (this.sessionLogger.isSessionActive() && prices) {
                this.sessionLogger.logTick({
                    tickNumber: this.tickCount,
                    timestamp: new Date().toISOString(),
                    timestampMs: Date.now(),
                    market: {
                        slug: marketInfo.eventSlug,
                        strikePrice: effectiveStrikePrice,
                        upTokenId: marketInfo.upTokenId,
                        downTokenId: marketInfo.downTokenId,
                        endDate: marketInfo.endDate.toISOString()
                    },
                    spotPrice: spotPrice,
                    difference: difference,
                    prices: {
                        upAsk: prices.upAsk,
                        upBid: prices.upBid,
                        downAsk: prices.downAsk,
                        downBid: prices.downBid
                    },
                    timeRemaining: timeRemainingSeconds
                });
            }

        } catch (error) {
            console.error('🔥 ERROR IN TICK:', error);
        }
    }

    /**
     * Start the bot
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            console.log('⚠️ Bot is already running');
            return;
        }

        console.log(`🚀 Starting bot... (Tick interval: ${CONFIG.TICK_INTERVAL}ms)`);
        this.isRunning = true;

        // Run first tick immediately (this will start the session when market is discovered)
        await this.tick();

        // Then run on interval
        this.intervalHandle = setInterval(() => {
            this.tick();
        }, CONFIG.TICK_INTERVAL);
    }

    /**
     * Stop the bot
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            console.log('⚠️ Bot is not running');
            return;
        }

        console.log('🛑 Stopping bot...');
        this.isRunning = false;

        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }

        // Cleanup
        this.spotPriceService.disconnect();

        // Flush session data to file (async, non-blocking)
        if (this.sessionLogger.isSessionActive()) {
            console.log('💾 Saving session data...');
            await this.sessionLogger.endSession();
        }

        // End trade logging session
        if (this.tradeLogger.isSessionActive()) {
            const stats = this.strategy.getStats();
            const records = this.strategy.getTradeRecords();
            const endingCapital = this.executionGateway.getPaperCash();  // 💰 Get final wallet balance
            this.tradeLogger.endSession(stats, records, endingCapital);
        }

        console.log('');
        console.log('📊 SESSION SUMMARY');
        console.log(`   Total Ticks: ${this.tickCount}`);
        const stats = this.strategy.getStats();
        console.log(`   Buy Orders: ${stats.executedBuyOrders}/${stats.totalBuyOrders} executed`);
        console.log(`   Sell Orders: ${stats.executedSellOrders}/${stats.totalSellOrders} executed`);
        console.log(`   Naked Positions: ${stats.nakedPositions} (bought but never sold)`);
        
        const sessionStats = this.sessionLogger.getSessionStats();
        if (sessionStats.tickCount > 0) {
            console.log(`   Logged Ticks: ${sessionStats.tickCount}`);
            console.log(`   Market: ${sessionStats.marketSlug}`);
        }
        console.log('');
        console.log('👋 Goodbye!');

        process.exit(0);
    }
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================

const bot = new TradingBot();

// Graceful shutdown handlers
process.on('SIGINT', () => {
    console.log('\n⚠️ Received SIGINT (Ctrl+C)');
    bot.stop();
});

process.on('SIGTERM', () => {
    console.log('\n⚠️ Received SIGTERM');
    bot.stop();
});

// Start the bot
bot.start();
