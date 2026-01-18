/**
 * Hedge Arbitrage Strategy (Paper Trading)
 *
 * Goal: At the start of each market session, buy BOTH UP and DOWN at a fixed price (default $0.49),
 * then hold to settlement. Because exactly one side settles at $1.00 and the other at $0.00,
 * buying both at $0.49/$0.49 yields a deterministic +$0.02 per share pair (ignoring fees).
 *
 * Notes:
 * - This strategy is intended for PAPER mode only (enforced in config validation).
 * - We simulate settlement by "selling" both positions at payout prices (1.00 / 0.00) once
 *   timeRemainingSeconds <= 0.
 */

import { ExecutionGateway, TradeRecord } from '../execution';
import { OrderBookService } from '../services/orderBookService';
import { MarketConfig } from '../slugOracle';
import { CONFIG } from '../config';
import type { StrategyStats, SessionState, CircuitBreakerState } from './ExpirationConvergenceStrategy';

export class HedgeArbitrage49Strategy {
    private executionGateway: ExecutionGateway;
    private orderBookService: OrderBookService;

    private tradeRecords: Map<string, TradeRecord> = new Map();
    private orderCounter = 0;

    private currentMarketSlug: string | null = null;
    private hasOpenedThisMarket = false;
    private hasSettledThisMarket = false;

    private upTokenId: string | null = null;
    private downTokenId: string | null = null;
    private sharesPerSide: number | null = null;

    private lastSpotPrice: number | null = null;
    private lastStrikePrice: number | null = null;

    private sessionState: SessionState = {
        sessionPnL: 0,
        sessionStartTime: Date.now(),
        isSessionLocked: false,
        lockReason: null,
        tradesThisSession: 0,
    };

    constructor(executionGateway: ExecutionGateway, orderBookService: OrderBookService) {
        this.executionGateway = executionGateway;
        this.orderBookService = orderBookService;

        console.log('');
        console.log('🧷 ════════════════════════════════════════');
        console.log('🧷   HEDGE ARB STRATEGY (PAPER)');
        console.log(`🧷   Buy BOTH @ $${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)} and hold to settlement`);
        console.log('🧷 ════════════════════════════════════════');
        console.log('');
    }

    // Compatibility with main.ts monitoring output
    getSessionState(): SessionState {
        return { ...this.sessionState };
    }

    // Compatibility: no circuit breaker used here
    getCircuitBreakerState(): CircuitBreakerState {
        return {
            isCoolingDown: false,
            crashLowPrice: 0,
            stabilityCounter: 0,
            lastStopLossTime: 0,
            crashTokenId: '',
            lastTradeTime: 0,
        };
    }

    // Compatibility: never use kill zone in hedge mode
    isInKillZone(_upAsk?: number, _upBid?: number, _downAsk?: number, _downBid?: number): boolean {
        return false;
    }

    /**
     * Entry decision: open once per market, then do nothing until settlement.
     */
    shouldEnterTrade(
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number,
        _currentPrices?: { upAsk: number; upBid: number; downAsk: number; downBid: number }
    ): { shouldTrade: boolean; direction: 'UP' | 'DOWN' | null; fairValue?: number; volatility?: number } {
        this.lastSpotPrice = spotPrice;
        this.lastStrikePrice = strikePrice;

        if (this.sessionState.isSessionLocked) {
            return { shouldTrade: false, direction: null };
        }

        // Only open once per market
        if (this.hasOpenedThisMarket) {
            return { shouldTrade: false, direction: null };
        }

        // Don't open if already expired
        if (timeRemainingSeconds <= 0) {
            return { shouldTrade: false, direction: null };
        }

        return { shouldTrade: true, direction: 'UP' };
    }

    /**
     * Open the hedge: buy BOTH tokens at fixed price.
     * (direction argument ignored; kept for compatibility)
     */
    async executeTrade(
        marketInfo: MarketConfig,
        _spotPrice: number,
        _strikePrice: number,
        _direction: 'UP' | 'DOWN',
        _fairValue: number = 0.0
    ): Promise<{ buyOrderId: string; sellOrderId: string } | null> {
        if (this.hasOpenedThisMarket) {
            return null;
        }

        this.currentMarketSlug = marketInfo.eventSlug;
        this.sessionState.sessionStartTime = Date.now();

        const entryPrice = CONFIG.HEDGE_ENTRY_PRICE;
        this.upTokenId = marketInfo.upTokenId;
        this.downTokenId = marketInfo.downTokenId;

        // Allocate capital: use up to MAX_CAPITAL_PER_TRADE, or whatever cash we have
        const cash = this.executionGateway.getPaperCash();
        const totalBudget = Math.min(CONFIG.MAX_CAPITAL_PER_TRADE, cash);

        // Need at least MIN_ORDER_SIZE per side (so >= 2 * MIN_ORDER_SIZE total)
        if (totalBudget < 2 * CONFIG.MIN_ORDER_SIZE) {
            console.log(
                `⚠️ Hedge skip: need at least $${(2 * CONFIG.MIN_ORDER_SIZE).toFixed(2)} cash for two buys, have $${cash.toFixed(2)}`
            );
            return null;
        }

        // Shares per side so total spend ≈ totalBudget at entryPrice/entryPrice
        // totalCost = shares * entryPrice * 2
        const rawShares = totalBudget / (2 * entryPrice);
        const shares = Math.floor(rawShares * 10000) / 10000; // 4dp
        const perSideAmount = shares * entryPrice;

        if (shares <= 0 || perSideAmount < CONFIG.MIN_ORDER_SIZE) {
            console.log(`⚠️ Hedge skip: computed shares too small (${shares}) / amount per side $${perSideAmount.toFixed(2)}`);
            return null;
        }

        this.sharesPerSide = shares;

        console.log('');
        console.log('🧷 ════════════════════════════════════════');
        console.log('🧷   OPENING HEDGE');
        console.log('🧷 ════════════════════════════════════════');
        console.log(`   Market: ${marketInfo.eventSlug}`);
        console.log(`   Entry Price: $${entryPrice.toFixed(2)} (both sides)`);
        console.log(`   Shares: ${shares.toFixed(4)} each side`);
        console.log(`   Spend: $${(perSideAmount * 2).toFixed(2)} total`);

        // Buy UP
        const upBuyId = await this.executionGateway.placeFOKOrder(
            marketInfo.upTokenId,
            'BUY',
            perSideAmount,
            entryPrice
        );

        const upBuyRecord: TradeRecord = {
            id: `trade_${this.orderCounter++}`,
            timestamp: Date.now(),
            marketSlug: marketInfo.eventSlug,
            side: 'BUY',
            tokenId: marketInfo.upTokenId,
            tokenType: 'UP',
            price: entryPrice,
            size: shares,
            orderId: upBuyId,
            status: 'FILLED',
        };
        this.tradeRecords.set(upBuyRecord.id, upBuyRecord);

        // Buy DOWN
        const downBuyId = await this.executionGateway.placeFOKOrder(
            marketInfo.downTokenId,
            'BUY',
            perSideAmount,
            entryPrice
        );

        const downBuyRecord: TradeRecord = {
            id: `trade_${this.orderCounter++}`,
            timestamp: Date.now(),
            marketSlug: marketInfo.eventSlug,
            side: 'BUY',
            tokenId: marketInfo.downTokenId,
            tokenType: 'DOWN',
            price: entryPrice,
            size: shares,
            orderId: downBuyId,
            status: 'FILLED',
        };
        this.tradeRecords.set(downBuyRecord.id, downBuyRecord);

        this.hasOpenedThisMarket = true;

        console.log(`   ✅ Bought UP @ $${entryPrice.toFixed(2)} (order ${upBuyId})`);
        console.log(`   ✅ Bought DOWN @ $${entryPrice.toFixed(2)} (order ${downBuyId})`);
        console.log(`   💰 Paper cash remaining: $${this.executionGateway.getPaperCash().toFixed(2)}`);
        console.log('🧷 ════════════════════════════════════════');

        // No sell orders in hedge mode; settlement happens at expiry.
        return { buyOrderId: upBuyId, sellOrderId: '' };
    }

    /**
     * Called every tick. In hedge mode we use it to detect expiry and settle the positions.
     */
    async updateOrderStatus(timeRemainingSeconds?: number): Promise<void> {
        if (!this.hasOpenedThisMarket || this.hasSettledThisMarket) {
            return;
        }
        if (timeRemainingSeconds === undefined) {
            return;
        }
        if (timeRemainingSeconds > 0) {
            return;
        }

        // Settle at expiry using lastSpot vs lastStrike
        if (this.lastSpotPrice === null || this.lastStrikePrice === null) {
            console.log('⚠️ Cannot settle hedge: missing last spot/strike');
            return;
        }

        console.log('');
        console.log('🏁 ════════════════════════════════════════');
        console.log('🏁   MARKET EXPIRED - SETTLING HEDGE');
        console.log('🏁 ════════════════════════════════════════');

        const upWins = this.lastSpotPrice >= this.lastStrikePrice;
        const upPayout = upWins ? 1.0 : 0.0;
        const downPayout = upWins ? 0.0 : 1.0;

        // Sell both positions at payout prices
        const positions = this.executionGateway.getAllPaperPositions();

        const upTokenId = this.upTokenId;
        const downTokenId = this.downTokenId;

        if (!upTokenId || !downTokenId) {
            console.log('⚠️ Cannot settle hedge: missing token IDs');
            return;
        }

        const upPosition = positions.find(p => p.tokenId === upTokenId);
        const downPosition = positions.find(p => p.tokenId === downTokenId);

        if (!upPosition || !downPosition) {
            console.log('⚠️ Cannot settle hedge: missing one side position (did both buys execute?)');
            return;
        }

        const shares = this.sharesPerSide ?? Math.min(upPosition.shares, downPosition.shares);

        await this.executionGateway.executeFAK(upTokenId, 'SELL', upPayout, shares);
        await this.executionGateway.executeFAK(downTokenId, 'SELL', downPayout, shares);

        const cashAfter = this.executionGateway.getPaperCash();

        // Record settlement "sell" trades
        const upSell: TradeRecord = {
            id: `trade_${this.orderCounter++}`,
            timestamp: Date.now(),
            marketSlug: this.currentMarketSlug || 'unknown',
            side: 'SELL',
            tokenId: upTokenId,
            tokenType: 'UP',
            price: upPayout,
            size: shares,
            orderId: `SETTLE_UP_${Date.now()}`,
            status: 'FILLED',
            exitType: 'HOLD_TO_MATURITY',
        };
        const downSell: TradeRecord = {
            id: `trade_${this.orderCounter++}`,
            timestamp: Date.now(),
            marketSlug: this.currentMarketSlug || 'unknown',
            side: 'SELL',
            tokenId: downTokenId,
            tokenType: 'DOWN',
            price: downPayout,
            size: shares,
            orderId: `SETTLE_DOWN_${Date.now()}`,
            status: 'FILLED',
            exitType: 'HOLD_TO_MATURITY',
        };
        this.tradeRecords.set(upSell.id, upSell);
        this.tradeRecords.set(downSell.id, downSell);

        // Update session P&L based on realized net (proceeds - invested)
        const stats = this.getStats();
        this.sessionState.sessionPnL = stats.realizedPNL;
        this.sessionState.tradesThisSession += 1;

        console.log(`   Spot: $${this.lastSpotPrice.toFixed(2)} | Strike: $${this.lastStrikePrice.toFixed(2)} | Winner: ${upWins ? 'UP' : 'DOWN'}`);
        console.log(`   ✅ Settled: UP=${upPayout.toFixed(2)}, DOWN=${downPayout.toFixed(2)} for ${shares.toFixed(4)} shares`);
        console.log(`   💰 Paper cash after settlement: $${cashAfter.toFixed(2)}`);

        this.hasSettledThisMarket = true;
    }

    getTradeRecords(): TradeRecord[] {
        return Array.from(this.tradeRecords.values());
    }

    getStats(_currentPrices?: { upBid: number; downBid: number }): StrategyStats {
        const records = Array.from(this.tradeRecords.values());
        const buys = records.filter(r => r.side === 'BUY' && r.status === 'FILLED');
        const sells = records.filter(r => r.side === 'SELL' && r.status === 'FILLED');

        const totalInvested = buys.reduce((s, r) => s + r.price * r.size, 0);
        const totalProceeds = sells.reduce((s, r) => s + r.price * r.size, 0);
        const realizedPNL = totalProceeds - totalInvested;

        return {
            totalBuyOrders: records.filter(r => r.side === 'BUY').length,
            totalSellOrders: records.filter(r => r.side === 'SELL').length,
            executedBuyOrders: buys.length,
            executedSellOrders: sells.length,
            stopLossExits: 0,
            limitSellFills: 0,
            cancelledSells: records.filter(r => r.side === 'SELL' && r.status === 'CANCELLED').length,
            nakedPositions: Math.max(0, buys.length - sells.length),
            totalTrades: records.length,
            totalInvested,
            totalProceeds,
            netPNL: realizedPNL,
            realizedPNL,
            unrealizedPNL: 0,
        };
    }

    async resetForNewMarket(): Promise<void> {
        this.tradeRecords.clear();
        this.orderCounter = 0;
        this.currentMarketSlug = null;
        this.hasOpenedThisMarket = false;
        this.hasSettledThisMarket = false;
        this.upTokenId = null;
        this.downTokenId = null;
        this.sharesPerSide = null;
        this.lastSpotPrice = null;
        this.lastStrikePrice = null;

        this.sessionState = {
            sessionPnL: 0,
            sessionStartTime: Date.now(),
            isSessionLocked: false,
            lockReason: null,
            tradesThisSession: 0,
        };

        await this.executionGateway.clearAllState();
    }
}

