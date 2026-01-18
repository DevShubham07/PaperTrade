/**
 * Hedge Arbitrage Strategy
 * 
 * Strategy: Buy both UP and DOWN tokens at a fixed price (e.g., $0.49) at market start.
 * At expiry, one token settles at $1.00 and the other at $0.00, guaranteeing a profit.
 * 
 * Example: Buy UP at $0.49 and DOWN at $0.49 (total $0.98).
 * At expiry: One token = $1.00, other = $0.00
 * Profit: $1.00 - $0.98 = $0.02 per share pair
 * 
 * Uses 20% of total bankroll per 15-minute market session.
 */

import { ExecutionGateway, TradeRecord } from '../execution';
import { OrderBookService } from '../services/orderBookService';
import { MarketConfig } from '../slugOracle';
import { CONFIG } from '../config';

export interface SessionState {
    sessionPnL: number;
    sessionStartTime: number;
    isSessionLocked: boolean;
    lockReason: 'PROFIT_TARGET' | 'LOSS_LIMIT' | null;
    tradesThisSession: number;
}

export interface CircuitBreakerState {
    isCoolingDown: boolean;
    crashLowPrice: number;
    stabilityCounter: number;
    lastStopLossTime: number;
    crashTokenId: string;
    lastTradeTime: number;
}

export interface StrategyStats {
    totalBuyOrders: number;
    totalSellOrders: number;
    executedBuyOrders: number;
    executedSellOrders: number;
    stopLossExits: number;
    limitSellFills: number;
    cancelledSells: number;
    nakedPositions: number;
    totalTrades: number;
    totalInvested: number;
    totalProceeds: number;
    netPNL: number;
    realizedPNL: number;
    unrealizedPNL: number;
}

export class HedgeArbitrage49Strategy {
    private executionGateway: ExecutionGateway;
    private orderBookService: OrderBookService;
    private tradeRecords: Map<string, TradeRecord> = new Map();
    private activePositions: Map<string, TradeRecord> = new Map();
    private orderCounter: number = 0;
    
    // Per-market state
    private hasEnteredThisMarket: boolean = false;
    private upTokenId: string | null = null;
    private downTokenId: string | null = null;
    private currentMarketSlug: string | null = null;
    private upPosition: TradeRecord | null = null;
    private downPosition: TradeRecord | null = null;
    private storedStrikePrice: number = 0;
    private lastUpOrderId: string | null = null;
    private lastDownOrderId: string | null = null;
    private lastFillStatusLogMs: number = 0;
    
    // Session state
    private sessionState: SessionState = {
        sessionPnL: 0,
        sessionStartTime: Date.now(),
        isSessionLocked: false,
        lockReason: null,
        tradesThisSession: 0
    };
    
    // Circuit breaker (minimal for this strategy)
    private circuitBreakerState: CircuitBreakerState = {
        isCoolingDown: false,
        crashLowPrice: 0,
        stabilityCounter: 0,
        lastStopLossTime: 0,
        crashTokenId: '',
        lastTradeTime: 0
    };
    
    // Stats
    private stats: StrategyStats = {
        totalBuyOrders: 0,
        totalSellOrders: 0,
        executedBuyOrders: 0,
        executedSellOrders: 0,
        stopLossExits: 0,
        limitSellFills: 0,
        cancelledSells: 0,
        nakedPositions: 0,
        totalTrades: 0,
        totalInvested: 0,
        totalProceeds: 0,
        netPNL: 0,
        realizedPNL: 0,
        unrealizedPNL: 0
    };

    constructor(executionGateway: ExecutionGateway, orderBookService: OrderBookService) {
        this.executionGateway = executionGateway;
        this.orderBookService = orderBookService;
        
        console.log('');
        console.log('🔄 ════════════════════════════════════════════');
        console.log('🔄   HEDGE ARBITRAGE STRATEGY');
        console.log('🔄 ════════════════════════════════════════════');
        console.log(`🔄   Entry Price: $${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)}`);
        console.log(`🔄   Capital per Market: 20% of bankroll`);
        console.log(`🔄   Strategy: Buy both UP and DOWN, hold to expiry`);
        console.log('🔄 ════════════════════════════════════════════');
        console.log('');
    }

    /**
     * Check if we should enter a trade (once per market session)
     */
    shouldEnterTrade(
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number,
        currentPrices?: { upAsk: number; upBid: number; downAsk: number; downBid: number }
    ): { shouldTrade: boolean; direction: 'UP' | 'DOWN' | null; fairValue?: number; volatility?: number } {
        // Only enter once per market (market info is handled in executeTrade)
        if (this.hasEnteredThisMarket) {
            return { shouldTrade: false, direction: null };
        }

        // Check if we have enough cash (need 20% of bankroll)
        const capitalPerMarket = CONFIG.BANKROLL * 0.20; // 20% of total bankroll
        const paperCash = this.executionGateway.getPaperCash();
        
        if (paperCash < capitalPerMarket) {
            console.log(`⚠️ Insufficient cash for hedge arbitrage. Need: $${capitalPerMarket.toFixed(2)}, Have: $${paperCash.toFixed(2)}`);
            return { shouldTrade: false, direction: null };
        }

        // IMPORTANT: You cannot expect BOTH asks to be in a narrow band simultaneously,
        // because UP and DOWN are complements (their prices tend to sum ~1).
        //
        // Instead, we place resting BUY LIMIT (bid) orders at our desired prices at market start.
        // They will fill if/when the market's ask comes down to our bid.
        //
        // We validate our *intended bid prices* are within range and sum < 1.
        const bidUp = CONFIG.HEDGE_ENTRY_PRICE;
        const bidDown = CONFIG.HEDGE_ENTRY_PRICE;
        const sum = bidUp + bidDown;

        const inRange =
            bidUp >= CONFIG.HEDGE_ENTRY_MIN_PRICE &&
            bidUp <= CONFIG.HEDGE_ENTRY_MAX_PRICE &&
            bidDown >= CONFIG.HEDGE_ENTRY_MIN_PRICE &&
            bidDown <= CONFIG.HEDGE_ENTRY_MAX_PRICE;

        const sumOk = sum <= CONFIG.HEDGE_MAX_COMBINED_PRICE;

        if (!inRange || !sumOk) return { shouldTrade: false, direction: null };

        // Direction is just a "go" signal for main.ts; we buy both legs in executeTrade().
        return { shouldTrade: true, direction: 'UP' };
    }

    /**
     * Execute the hedge arbitrage trade
     */
    async executeTrade(
        marketInfo: MarketConfig,
        spotPrice: number,
        strikePrice: number,
        direction: 'UP' | 'DOWN',
        fairValue: number = 0.0
    ): Promise<{ buyOrderId: string; sellOrderId?: string } | null> {
        // Reset if we're in a new market
        if (this.currentMarketSlug !== marketInfo.eventSlug) {
            this.hasEnteredThisMarket = false;
            this.currentMarketSlug = marketInfo.eventSlug;
            this.upTokenId = marketInfo.upTokenId;
            this.downTokenId = marketInfo.downTokenId;
            this.upPosition = null;
            this.downPosition = null;
            this.lastUpOrderId = null;
            this.lastDownOrderId = null;
            // In this simplified hedge mode, we don't need strike/spot for settlement.
            this.storedStrikePrice = 0;
        }

        if (this.hasEnteredThisMarket) {
            return null;
        }

        const capitalPerMarket = CONFIG.BANKROLL * 0.20; // 20% of total bankroll
        const capitalPerToken = capitalPerMarket / 2; // Split equally: $1 UP + $1 DOWN for $10 bankroll

        console.log('');
        console.log('🔄 ════════════════════════════════════════════');
        console.log('🔄   EXECUTING HEDGE ARBITRAGE');
        console.log('🔄 ════════════════════════════════════════════');
        console.log(`💰 Capital per market: $${capitalPerMarket.toFixed(2)}`);
        console.log(`💰 Capital per token: $${capitalPerToken.toFixed(2)}`);
        console.log(`💰 Entry price: $${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)}`);
        console.log('🔄 ════════════════════════════════════════════');
        console.log('');

        try {
            // Place resting bids at our desired prices (same bid for both legs by default).
            // These orders may remain pending; main.ts will poll order books and call checkPaperFills().
            const bidUp = CONFIG.HEDGE_ENTRY_PRICE;
            const bidDown = CONFIG.HEDGE_ENTRY_PRICE;
            const sharesUp = capitalPerToken / bidUp;
            const sharesDown = capitalPerToken / bidDown;

            console.log(`🧾 Placing hedge bids: UP bid=$${bidUp.toFixed(4)} DOWN bid=$${bidDown.toFixed(4)} | BidSum=$${(bidUp + bidDown).toFixed(4)}`);
            console.log(`🧾 Range=[${CONFIG.HEDGE_ENTRY_MIN_PRICE.toFixed(3)}-${CONFIG.HEDGE_ENTRY_MAX_PRICE.toFixed(3)}] SumMax=${CONFIG.HEDGE_MAX_COMBINED_PRICE.toFixed(3)}`);

            console.log(`🔄 Placing UP BUY LIMIT: ${sharesUp.toFixed(4)} shares @ $${bidUp.toFixed(4)}`);
            const upOrderId = await this.executionGateway.placeLimitOrder(
                marketInfo.upTokenId,
                'BUY',
                bidUp,
                sharesUp,
                'GTC'
            );
            console.log(`✅ UP limit order placed: ${upOrderId}`);

            console.log(`🔄 Placing DOWN BUY LIMIT: ${sharesDown.toFixed(4)} shares @ $${bidDown.toFixed(4)}`);
            const downOrderId = await this.executionGateway.placeLimitOrder(
                marketInfo.downTokenId,
                'BUY',
                bidDown,
                sharesDown,
                'GTC'
            );
            console.log(`✅ DOWN limit order placed: ${downOrderId}`);

            this.lastUpOrderId = upOrderId;
            this.lastDownOrderId = downOrderId;

            // LIMIT orders may be pending until market asks cross our bids.
            const upFilled = await this.executionGateway.isOrderFilled(upOrderId);
            const downFilled = await this.executionGateway.isOrderFilled(downOrderId);

            // Record positions
            const upTrade: TradeRecord = {
                id: `hedge_up_${Date.now()}`,
                timestamp: Date.now(),
                marketSlug: marketInfo.eventSlug,
                side: 'BUY',
                tokenId: marketInfo.upTokenId,
                tokenType: 'UP',
                price: bidUp,
                size: sharesUp,
                orderId: upOrderId,
                status: upFilled ? 'FILLED' : 'PENDING'
            };

            const downTrade: TradeRecord = {
                id: `hedge_down_${Date.now()}`,
                timestamp: Date.now(),
                marketSlug: marketInfo.eventSlug,
                side: 'BUY',
                tokenId: marketInfo.downTokenId,
                tokenType: 'DOWN',
                price: bidDown,
                size: sharesDown,
                orderId: downOrderId,
                status: downFilled ? 'FILLED' : 'PENDING'
            };

            this.tradeRecords.set(upOrderId, upTrade);
            this.tradeRecords.set(downOrderId, downTrade);
            this.activePositions.set(upOrderId, upTrade);
            this.activePositions.set(downOrderId, downTrade);
            this.upPosition = upTrade;
            this.downPosition = downTrade;

            this.hasEnteredThisMarket = true;
            this.stats.totalBuyOrders += 2;
            this.sessionState.tradesThisSession += 2;
            this.stats.executedBuyOrders += (upFilled ? 1 : 0) + (downFilled ? 1 : 0);

            console.log('✅ Hedge arbitrage entry attempted');
            console.log(`   UP:   ${sharesUp.toFixed(4)} shares @ $${bidUp.toFixed(4)} | ${upFilled ? 'FILLED' : 'PENDING'} (${upOrderId})`);
            console.log(`   DOWN: ${sharesDown.toFixed(4)} shares @ $${bidDown.toFixed(4)} | ${downFilled ? 'FILLED' : 'PENDING'} (${downOrderId})`);
            console.log(`   Total invested: $${capitalPerMarket.toFixed(2)}`);
            console.log(`   Remaining cash: $${this.executionGateway.getPaperCash().toFixed(2)}`);
            console.log('');

            // Return the order IDs (main.ts expects this format)
            return {
                buyOrderId: upOrderId,
                sellOrderId: downOrderId // We don't have a sell order yet, but return downOrderId as placeholder
            };

        } catch (error: any) {
            console.error('❌ Error executing hedge arbitrage:', error.message);
            return null;
        }
    }

    /**
     * Update order status and handle settlement at market expiry
     */
    async updateOrderStatus(timeRemainingSeconds: number, spotPrice: number = 0): Promise<void> {
        // Check if market is expiring (within 10 seconds)
        if (timeRemainingSeconds <= 10 && this.upPosition && this.downPosition) {
            // Market is expiring - settle positions
            await this.settlePositions();
        } else {
            // Lightweight fill-status logging (throttled) to show if anything is still pending
            if (this.lastUpOrderId && this.lastDownOrderId && Date.now() - this.lastFillStatusLogMs > 10_000) {
                const upFilled = await this.executionGateway.isOrderFilled(this.lastUpOrderId);
                const downFilled = await this.executionGateway.isOrderFilled(this.lastDownOrderId);
                const status = upFilled && downFilled ? 'BOTH FILLED ✅' : `UP=${upFilled ? 'FILLED' : 'PENDING'} DOWN=${downFilled ? 'FILLED' : 'PENDING'}`;
                console.log(`📌 Hedge entry status: ${status} | Buy price=$${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)}`);
                this.lastFillStatusLogMs = Date.now();
            }

            // Check for fills on pending orders
            const upPosition = this.executionGateway.getPaperPosition();
            if (upPosition && this.upTokenId && upPosition.tokenId === this.upTokenId) {
                // UP position filled
                if (this.upPosition && this.upPosition.status === 'PENDING') {
                    this.upPosition.status = 'FILLED';
                    this.stats.executedBuyOrders++;
                }
            }

            // Check DOWN position
            const positions = this.executionGateway.getAllPaperPositions();
            const downPos = positions.find(p => p.tokenId === this.downTokenId);
            if (downPos && this.downPosition && this.downPosition.status === 'PENDING') {
                this.downPosition.status = 'FILLED';
                this.stats.executedBuyOrders++;
            }
        }
    }

    /**
     * Settle positions at market expiry
     * One token becomes $1.00, the other becomes $0.00
     */
    private async settlePositions(): Promise<void> {
        if (!this.upPosition || !this.downPosition || !this.upTokenId || !this.downTokenId) {
            return;
        }

        // Get current positions from execution gateway
        const positions = this.executionGateway.getAllPaperPositions();
        const upPos = positions.find(p => p.tokenId === this.upTokenId);
        const downPos = positions.find(p => p.tokenId === this.downTokenId);

        if (!upPos || !downPos) {
            console.log('⚠️ Cannot settle - positions not found');
            return;
        }

        // Get the minimum shares (in case of partial fills)
        const shares = Math.min(upPos.shares, downPos.shares);

        if (shares <= 0) {
            console.log('⚠️ Cannot settle - no shares to settle');
            return;
        }

        // We don't need BTC spot/strike to realize the hedge arbitrage payout in paper mode.
        // For a paired hedge position, total payout is always $1.00 per share-pair.
        // We can arbitrarily mark UP as the winner for settlement accounting.
        const upSellPrice = 1.00;
        const downSellPrice = 0.00;

        console.log('');
        console.log('🔄 ════════════════════════════════════════════');
        console.log('🔄   SETTLING HEDGE ARBITRAGE POSITIONS');
        console.log('🔄 ════════════════════════════════════════════');
        console.log(`📊 Settlement: UP=$${upSellPrice.toFixed(2)} DOWN=$${downSellPrice.toFixed(2)} (paper)`);        
        console.log(`📊 UP shares: ${upPos.shares.toFixed(4)}`);
        console.log(`📊 DOWN shares: ${downPos.shares.toFixed(4)}`);
        console.log(`📊 Settling: ${shares.toFixed(4)} shares`);
        console.log('🔄 ════════════════════════════════════════════');
        console.log('');

        // Sell both tokens at settlement prices
        console.log(`💰 Selling UP: ${shares.toFixed(4)} shares @ $${upSellPrice.toFixed(2)}`);
        await this.executionGateway.executeFAK(
            this.upTokenId,
            'SELL',
            shares,
            upSellPrice
        );

        console.log(`💰 Selling DOWN: ${shares.toFixed(4)} shares @ $${downSellPrice.toFixed(2)}`);
        await this.executionGateway.executeFAK(
            this.downTokenId,
            'SELL',
            shares,
            downSellPrice
        );

        // Calculate profit
        const totalInvested = (upPos.entryPrice + downPos.entryPrice) * shares;
        const totalProceeds = (upSellPrice + downSellPrice) * shares;
        const profit = totalProceeds - totalInvested;

        console.log('');
        console.log('✅ Settlement complete');
        console.log(`   Invested: $${totalInvested.toFixed(2)}`);
        console.log(`   Proceeds: $${totalProceeds.toFixed(2)}`);
        console.log(`   Profit: $${profit.toFixed(2)}`);
        console.log('');

        // Update stats
        this.stats.totalProceeds += totalProceeds;
        this.stats.realizedPNL += profit;
        this.sessionState.sessionPnL += profit;

        // Clear positions
        this.upPosition = null;
        this.downPosition = null;
    }

    /**
     * Get session state (required by main.ts)
     */
    getSessionState(): SessionState {
        return this.sessionState;
    }

    /**
     * Get circuit breaker state (required by main.ts)
     */
    getCircuitBreakerState(): CircuitBreakerState {
        return this.circuitBreakerState;
    }

    /**
     * Check if in kill zone (not used in hedge arbitrage)
     */
    isInKillZone(upAsk: number, upBid: number, downAsk: number, downBid: number): boolean {
        return false; // No kill zone for hedge arbitrage
    }

    /**
     * Get trade records (required by main.ts)
     */
    getTradeRecords(): TradeRecord[] {
        return Array.from(this.tradeRecords.values());
    }

    /**
     * Get strategy stats (required by main.ts)
     */
    getStats(): StrategyStats {
        return this.stats;
    }

    /**
     * Reset for new market (required by main.ts)
     */
    resetForNewMarket(): void {
        this.hasEnteredThisMarket = false;
        this.upTokenId = null;
        this.downTokenId = null;
        this.currentMarketSlug = null;
        this.upPosition = null;
        this.downPosition = null;
    }
}
