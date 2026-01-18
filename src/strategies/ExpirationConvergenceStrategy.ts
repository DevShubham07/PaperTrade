/**
 * Senior Quant Strategy v2.1 - Simplified Scalper
 * 
 * PHILOSOPHY: "Keep it simple. Fixed targets. Trust tight stops."
 *
 * === v2.1 SIMPLIFICATIONS ===
 * 1. ❌ REMOVED: Fair value / Z-score calculation (was causing bad entries)
 * 2. ❌ REMOVED: Trend confirmation (too restrictive)
 * 3. ❌ REMOVED: Dynamic stop/profit based on spread
 * 4. ✅ FIXED 2¢ profit target (achievable in seconds)
 * 5. ✅ FIXED 4¢ stop loss (cuts losses fast)
 * 6. ✅ Breakeven at +1.5¢ (protects winners early)
 *
 * === KEPT FROM v2.0 ===
 * - Session profit lock (+$0.50) and loss limit (-$0.40)
 * - Safe zone $0.65-$0.85
 * - Circuit breaker with time + tick cooldown
 * - Trade rate limiter
 *
 * === EXECUTION ===
 * - Entry: FOK (Fill-Or-Kill)
 * - Stop Loss: FAK (Fill-And-Kill) at Bid - $0.02
 * - Take Profit: GTC Limit at entry + 2¢
 */

import { ExecutionGateway, TradeRecord } from '../execution';
import { OrderBookService } from '../services/orderBookService';
import { MarketConfig } from '../slugOracle';
import { QuantEngine } from '../services/quantEngine';
import { CONFIG } from '../config';

/**
 * 🔄 GLOBAL STATE - Circuit Breaker for Crash Stability
 * Prevents "falling knife" re-entries after stop-loss
 */
export interface CircuitBreakerState {
    isCoolingDown: boolean;          // Are we in cooldown mode?
    crashLowPrice: number;           // The lowest price seen during the crash
    stabilityCounter: number;        // How many ticks price has held above crash low
    lastStopLossTime: number;        // Timestamp of last stop-loss (for TIME-based cooldown)
    crashTokenId: string;            // Which token triggered the cooldown
    lastTradeTime: number;           // Timestamp of last trade (for rate limiting)
}

/**
 * 📈 SESSION STATE - Tracks P&L for profit locking (v2.0)
 * Prevents giving back gains and limits losses per session
 */
export interface SessionState {
    sessionPnL: number;              // Running P&L for this session
    sessionStartTime: number;        // When this session started
    isSessionLocked: boolean;        // Whether we hit profit target or loss limit
    lockReason: 'PROFIT_TARGET' | 'LOSS_LIMIT' | null;  // Why session was locked
    tradesThisSession: number;       // Count of trades in this session
}

/**
 * 📊 PRICE HISTORY BUFFER - For trend confirmation (v2.0)
 * Ring buffer to track recent prices for momentum detection
 */
export interface PriceHistoryBuffer {
    upBids: number[];                // Recent UP token bids
    downBids: number[];              // Recent DOWN token bids
    maxSize: number;                 // Max buffer size (TREND_LOOKBACK_TICKS)
}

/**
 * 📈 DYNAMIC RISK CALCULATION - Based on current market spread
 */
export interface DynamicRiskParams {
    requiredStopDist: number;        // Calculated stop distance
    targetProfit: number;            // Calculated profit target
    isValid: boolean;                // Whether trade passes risk gates
    rejectReason: string | null;     // Why trade was rejected (if any)
}

export interface StrategyStats {
    totalBuyOrders: number;
    totalSellOrders: number;
    executedBuyOrders: number;
    executedSellOrders: number;
    stopLossExits: number; // Positions closed via stop-loss
    limitSellFills: number; // Positions closed via limit sell
    cancelledSells: number; // Sell orders that were cancelled
    nakedPositions: number; // Bought but never sold
    totalTrades: number;
    totalInvested: number; // Total amount invested (all filled buy orders)
    totalProceeds: number; // Total proceeds from filled sell orders
    netPNL: number; // Net profit/loss (proceeds - invested)
    realizedPNL: number; // PNL from completed trades (buy + sell both filled)
    unrealizedPNL: number; // PNL from naked positions (bought but not sold)
}

export class ExpirationConvergenceStrategy {
    private executionGateway: ExecutionGateway;
    private orderBookService: OrderBookService;
    private quantEngine: QuantEngine;
    private tradeRecords: Map<string, TradeRecord> = new Map();
    private activePositions: Map<string, TradeRecord> = new Map(); // orderId -> buy order
    private orderCounter: number = 0;
    private isTradingLocked: boolean = false; // 🔒 Lock to prevent "Double-Tap" concurrency bug

    // 🔄 CIRCUIT BREAKER STATE
    private circuitBreaker: CircuitBreakerState = {
        isCoolingDown: false,
        crashLowPrice: 0,
        stabilityCounter: 0,
        lastStopLossTime: 0,
        crashTokenId: '',
        lastTradeTime: 0
    };

    // 📈 SESSION STATE (v2.0 - Profit Locking)
    private sessionState: SessionState = {
        sessionPnL: 0,
        sessionStartTime: Date.now(),
        isSessionLocked: false,
        lockReason: null,
        tradesThisSession: 0
    };

    // 📊 PRICE HISTORY BUFFER (v2.0 - Trend Confirmation)
    private priceHistory: PriceHistoryBuffer = {
        upBids: [],
        downBids: [],
        maxSize: CONFIG.TREND_LOOKBACK_TICKS
    };

    constructor(executionGateway: ExecutionGateway, orderBookService: OrderBookService) {
        this.executionGateway = executionGateway;
        this.orderBookService = orderBookService;
        this.quantEngine = new QuantEngine();
        
        console.log('');
        console.log('🤖 ════════════════════════════════════════');
        console.log('🤖   SENIOR QUANT STRATEGY v2.1');
        console.log('🤖   Mode: SIMPLIFIED SCALPER');
        console.log('🤖 ════════════════════════════════════════');
        console.log(`🤖   Safe Zone: $${CONFIG.MIN_ENTRY_PRICE.toFixed(2)} - $${CONFIG.MAX_ENTRY_PRICE.toFixed(2)}`);
        console.log('🤖   --- FIXED RISK PARAMS ---');
        console.log(`🤖   Profit Target: +$${CONFIG.FIXED_PROFIT_TARGET.toFixed(2)} (fixed)`);
        console.log(`🤖   Stop Loss: -$${CONFIG.FIXED_STOP_LOSS.toFixed(2)} (fixed)`);
        console.log(`🤖   Breakeven at: +$${CONFIG.BREAKEVEN_TRIGGER.toFixed(3)}`);
        console.log('🤖   --- SESSION LIMITS ---');
        console.log(`🤖   Lock profits at: +$${CONFIG.SESSION_PROFIT_TARGET.toFixed(2)}`);
        console.log(`🤖   Stop losses at: -$${CONFIG.SESSION_LOSS_LIMIT.toFixed(2)}`);
        console.log('🤖   --- REMOVED IN v2.1 ---');
        console.log('🤖   ❌ Fair value / Z-score');
        console.log('🤖   ❌ Trend confirmation');
        console.log('🤖   ❌ Dynamic stop/profit');
        console.log('🤖 ════════════════════════════════════════');
        console.log('');
    }

    /**
     * 🛡️ SAFE ZONE CHECK (Senior Quant v2.0)
     * Only allow trading in the $0.65-$0.85 range (tightened for buffer)
     * Returns true if prices are OUTSIDE safe zone (should NOT trade)
     */
    isInKillZone(upAsk: number, upBid: number, downAsk: number, downBid: number): boolean {
        // Use ask price for entry consideration (what we'd buy at)
        const upPrice = upAsk > 0 ? upAsk : upBid;
        const downPrice = downAsk > 0 ? downAsk : downBid;

        // Check if EITHER token is in safe zone (we can trade the one that is)
        const upInSafeZone = upPrice >= CONFIG.MIN_ENTRY_PRICE && upPrice <= CONFIG.MAX_ENTRY_PRICE;
        const downInSafeZone = downPrice >= CONFIG.MIN_ENTRY_PRICE && downPrice <= CONFIG.MAX_ENTRY_PRICE;

        // If NEITHER is in safe zone, reject
        if (!upInSafeZone && !downInSafeZone) {
            console.log(`🛡️ OUTSIDE SAFE ZONE: UP: $${upPrice.toFixed(4)}, DOWN: $${downPrice.toFixed(4)}`);
            console.log(`   Required: $${CONFIG.MIN_ENTRY_PRICE.toFixed(2)} - $${CONFIG.MAX_ENTRY_PRICE.toFixed(2)}`);
            return true; // Kill = true means don't trade
        }

        return false; // At least one token is tradeable
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 📈 SESSION MANAGEMENT (v2.0 - Profit Locking)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 📈 UPDATE SESSION P&L
     * Called after each trade completes to update running session P&L
     * Checks if we've hit profit target or loss limit
     */
    private updateSessionPnL(pnlChange: number): void {
        this.sessionState.sessionPnL += pnlChange;
        this.sessionState.tradesThisSession++;

        console.log(`📈 Session P&L: $${this.sessionState.sessionPnL.toFixed(2)} (${this.sessionState.tradesThisSession} trades)`);

        // Check profit target
        if (this.sessionState.sessionPnL >= CONFIG.SESSION_PROFIT_TARGET) {
            this.sessionState.isSessionLocked = true;
            this.sessionState.lockReason = 'PROFIT_TARGET';
            console.log('');
            console.log('🎉 ════════════════════════════════════════');
            console.log('🎉   SESSION PROFIT TARGET HIT!');
            console.log(`🎉   P&L: +$${this.sessionState.sessionPnL.toFixed(2)}`);
            console.log('🎉   Locking gains - no more trades this session');
            console.log('🎉 ════════════════════════════════════════');
            console.log('');
        }

        // Check loss limit
        if (this.sessionState.sessionPnL <= -CONFIG.SESSION_LOSS_LIMIT) {
            this.sessionState.isSessionLocked = true;
            this.sessionState.lockReason = 'LOSS_LIMIT';
            console.log('');
            console.log('🛑 ════════════════════════════════════════');
            console.log('🛑   SESSION LOSS LIMIT HIT!');
            console.log(`🛑   P&L: -$${Math.abs(this.sessionState.sessionPnL).toFixed(2)}`);
            console.log('🛑   Stopping to prevent further losses');
            console.log('🛑 ════════════════════════════════════════');
            console.log('');
        }
    }

    /**
     * 📈 CHECK SESSION STATUS
     * Returns true if session is locked (hit target or limit)
     */
    isSessionLocked(): boolean {
        return this.sessionState.isSessionLocked;
    }

    /**
     * 📈 GET SESSION STATE (for external monitoring)
     */
    getSessionState(): SessionState {
        return { ...this.sessionState };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 📊 TREND CONFIRMATION (v2.0 - Momentum Filter)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 📊 UPDATE PRICE HISTORY
     * Called each tick to update the price history ring buffer
     */
    updatePriceHistory(upBid: number, downBid: number): void {
        // Add new prices
        if (upBid > 0) {
            this.priceHistory.upBids.push(upBid);
            if (this.priceHistory.upBids.length > this.priceHistory.maxSize) {
                this.priceHistory.upBids.shift(); // Remove oldest
            }
        }

        if (downBid > 0) {
            this.priceHistory.downBids.push(downBid);
            if (this.priceHistory.downBids.length > this.priceHistory.maxSize) {
                this.priceHistory.downBids.shift(); // Remove oldest
            }
        }
    }

    /**
     * 📊 CHECK TREND CONFIRMATION
     * Returns true if price has moved at least MIN_TREND_DELTA in the specified direction
     * over the last TREND_LOOKBACK_TICKS ticks
     * 
     * @param direction - 'UP' or 'DOWN' (which token we're considering buying)
     * @returns { confirmed: boolean, trendDelta: number }
     */
    checkTrendConfirmation(direction: 'UP' | 'DOWN'): { confirmed: boolean; trendDelta: number; reason?: string } {
        const history = direction === 'UP' ? this.priceHistory.upBids : this.priceHistory.downBids;

        // Need enough history
        if (history.length < CONFIG.TREND_LOOKBACK_TICKS) {
            return { 
                confirmed: false, 
                trendDelta: 0, 
                reason: `Insufficient history: ${history.length}/${CONFIG.TREND_LOOKBACK_TICKS} ticks` 
            };
        }

        // Calculate trend: current price vs oldest price in buffer
        const oldestPrice = history[0];
        const currentPrice = history[history.length - 1];
        const trendDelta = currentPrice - oldestPrice;

        // For a BUY signal, we want price to be RISING (positive delta)
        // This means the market is moving in our direction BEFORE we enter
        if (trendDelta >= CONFIG.MIN_TREND_DELTA) {
            return { 
                confirmed: true, 
                trendDelta,
                reason: `Momentum confirmed: +$${trendDelta.toFixed(4)} over ${CONFIG.TREND_LOOKBACK_TICKS} ticks`
            };
        }

        // Trend not confirmed - market is choppy or moving against us
        return { 
            confirmed: false, 
            trendDelta,
            reason: `Choppy market: $${trendDelta.toFixed(4)} < $${CONFIG.MIN_TREND_DELTA.toFixed(2)} required`
        };
    }

    /**
     * 🔄 CIRCUIT BREAKER CHECK (Senior Quant v1.3.1)
     * After a stop-loss, wait for market to stabilize before re-entering
     * 
     * 🔧 FIX: Now requires BOTH conditions to release:
     * 1. TIME-based: Minimum cooldown period (default 15 seconds)
     * 2. TICK-based: Price must hold above crash low for X ticks (default 15)
     * 
     * @param currentBid - Current best bid for the crashed token
     * @returns true if we should skip trading this tick (still cooling down)
     */
    async checkCircuitBreaker(currentBid: number): Promise<boolean> {
        if (!this.circuitBreaker.isCoolingDown) {
            return false; // Not in cooldown, proceed normally
        }

        const now = Date.now();
        const timeSinceStopLoss = now - this.circuitBreaker.lastStopLossTime;
        const timeRemaining = Math.max(0, CONFIG.MIN_COOLDOWN_MS - timeSinceStopLoss);
        
        // 🔧 CHECK 1: TIME-based cooldown (HARD requirement)
        if (timeSinceStopLoss < CONFIG.MIN_COOLDOWN_MS) {
            console.log(`⏳ TIME COOLDOWN: ${(timeRemaining / 1000).toFixed(1)}s remaining (minimum ${CONFIG.MIN_COOLDOWN_MS / 1000}s after stop-loss)`);
            
            // Still track price stability during time cooldown
            if (currentBid < this.circuitBreaker.crashLowPrice && currentBid > 0) {
                this.circuitBreaker.crashLowPrice = currentBid;
                this.circuitBreaker.stabilityCounter = 0;
                console.log(`📉 FALLING KNIFE: New low $${currentBid.toFixed(4)} - Counter reset`);
            } else if (currentBid > this.circuitBreaker.crashLowPrice) {
                this.circuitBreaker.stabilityCounter++;
            }
            
            return true; // Time cooldown not expired
        }

        // 🔧 CHECK 2: TICK-based stability (price must hold)
        // If price makes a NEW LOW, the crash is still happening
        if (currentBid < this.circuitBreaker.crashLowPrice && currentBid > 0) {
            this.circuitBreaker.crashLowPrice = currentBid;
            this.circuitBreaker.stabilityCounter = 0; // Reset timer
            console.log(`📉 FALLING KNIFE DETECTED: New low $${currentBid.toFixed(4)} - Reset stability counter`);
            return true; // Skip trading
        }

        // If price holds above low, increment confidence
        if (currentBid > this.circuitBreaker.crashLowPrice) {
            this.circuitBreaker.stabilityCounter++;
            console.log(`📊 Stability check: ${this.circuitBreaker.stabilityCounter}/${CONFIG.STABILITY_TICKS_REQUIRED} ticks above crash low ($${this.circuitBreaker.crashLowPrice.toFixed(4)})`);
        }

        // 🔧 BOTH conditions must be met to release
        if (this.circuitBreaker.stabilityCounter >= CONFIG.STABILITY_TICKS_REQUIRED) {
            this.circuitBreaker.isCoolingDown = false;
            this.circuitBreaker.stabilityCounter = 0;
            this.circuitBreaker.crashLowPrice = 0;
            this.circuitBreaker.crashTokenId = '';
            console.log('✅ CIRCUIT BREAKER RELEASED: Time + stability requirements met. Resuming trading.');
            return false; // Can trade now
        }

        console.log(`⏳ COOLDOWN ACTIVE: Time passed ✓, waiting for stability (${this.circuitBreaker.stabilityCounter}/${CONFIG.STABILITY_TICKS_REQUIRED})`);
        return true; // Still cooling down
    }

    /**
     * 🔥 TRIGGER CIRCUIT BREAKER
     * Called after a stop-loss to prevent immediate re-entry
     */
    private triggerCircuitBreaker(tokenId: string, crashPrice: number): void {
        this.circuitBreaker.isCoolingDown = true;
        this.circuitBreaker.crashLowPrice = crashPrice;
        this.circuitBreaker.stabilityCounter = 0;
        this.circuitBreaker.lastStopLossTime = Date.now();
        this.circuitBreaker.crashTokenId = tokenId;
        
        console.log('');
        console.log('🔴 ========================================');
        console.log('🔴 CIRCUIT BREAKER TRIGGERED');
        console.log(`🔴 Crash Price: $${crashPrice.toFixed(4)}`);
        console.log(`🔴 Required: ${CONFIG.STABILITY_TICKS_REQUIRED} stable ticks to resume`);
        console.log('🔴 ========================================');
        console.log('');
    }

    /**
     * 📈 CALCULATE DYNAMIC RISK PARAMETERS (Senior Quant v1.3)
     * Based on current market spread, calculates stop distance and profit target
     */
    calculateDynamicRisk(bestAsk: number, bestBid: number): DynamicRiskParams {
        const spread = bestAsk - bestBid;

        // GATE 1: Price Zone (Strict)
        if (bestAsk < CONFIG.MIN_ENTRY_PRICE) {
            return {
                requiredStopDist: 0,
                targetProfit: 0,
                isValid: false,
                rejectReason: `GAMMA_TRAP: Price $${bestAsk.toFixed(4)} < $${CONFIG.MIN_ENTRY_PRICE.toFixed(2)}`
            };
        }
        if (bestAsk > CONFIG.MAX_ENTRY_PRICE) {
            return {
                requiredStopDist: 0,
                targetProfit: 0,
                isValid: false,
                rejectReason: `BAD_RR: Price $${bestAsk.toFixed(4)} > $${CONFIG.MAX_ENTRY_PRICE.toFixed(2)}`
            };
        }

        // GATE 2: Volatility Filter (Spread)
        if (spread > CONFIG.MAX_ALLOWED_SPREAD) {
            return {
                requiredStopDist: 0,
                targetProfit: 0,
                isValid: false,
                rejectReason: `SPREAD_TOO_WIDE: $${spread.toFixed(4)} > $${CONFIG.MAX_ALLOWED_SPREAD.toFixed(2)}`
            };
        }

        // GATE 3: Dynamic Math
        // We need 2.5x spread breathing room for the stop
        const requiredStopDist = Math.max(CONFIG.MIN_STOP_DISTANCE, spread * CONFIG.STOP_LOSS_SPREAD_MULTIPLIER);

        // Check if that stop is too big for our bankroll
        if (requiredStopDist > CONFIG.MAX_TOLERABLE_STOP) {
            return {
                requiredStopDist,
                targetProfit: 0,
                isValid: false,
                rejectReason: `REQ_STOP_TOO_LARGE: $${requiredStopDist.toFixed(4)} > $${CONFIG.MAX_TOLERABLE_STOP.toFixed(2)}`
            };
        }

        // Calculate Target Profit: (Spread * 2) + Base Risk Premium
        const targetProfit = (spread * 2) + CONFIG.BASE_RISK_PREMIUM;

        return {
            requiredStopDist,
            targetProfit,
            isValid: true,
            rejectReason: null
        };
    }

    /**
     * Get circuit breaker state (for external monitoring)
     */
    getCircuitBreakerState(): CircuitBreakerState {
        return { ...this.circuitBreaker };
    }

    /**
     * Check if we have any pending trades (buy+sell pair not both filled)
     * Also checks if we have sufficient cash for a new trade
     */
    hasPendingTrades(): boolean {
        // 🔒 Check concurrency lock first
        if (this.isTradingLocked) {
            return true;
        }

        const records = Array.from(this.tradeRecords.values());
        const buyOrders = records.filter(r => r.side === 'BUY' && r.status === 'FILLED');
        
        // Check if any filled buy order doesn't have a FILLED sell order
        // 🔧 FIX: Look specifically for a FILLED sell, not just any sell with pairedWith
        // This handles the case where a limit sell is CANCELLED but a stop-loss sell is FILLED
        for (const buy of buyOrders) {
            const filledSell = records.find(r => r.pairedWith === buy.id && r.status === 'FILLED');
            if (!filledSell) {
                // Check if there's a pending (not cancelled) sell
                const pendingSell = records.find(r => r.pairedWith === buy.id && r.status === 'PENDING');
                if (pendingSell) {
                    return true; // Found a pending trade pair
                }
                // If no filled sell AND no pending sell, check activePositions
                if (this.activePositions.has(buy.id)) {
                    return true; // Position still open
                }
            }
        }
        
        // Also check if we have any active positions (bought but not sold)
        if (this.activePositions.size > 0) {
            return true; // We have active positions, don't place new trades
        }
        
        // Check if we have sufficient cash (need at least 10% of current cash)
        const availableCash = this.executionGateway.getPaperCash();
        const minTradeAmount = availableCash * 0.10;
        if (availableCash < minTradeAmount) {
            return true; // Not enough cash for a trade
        }
        
        return false; // All trades are complete and we have cash
    }

    /**
     * Check if we should enter a trade based on strategy rules
     * Senior Quant v2.0: Profit Maximizer with session limits and trend confirmation
     * 
     * @param currentPrices - Current market prices for HARD price filter enforcement
     */
    shouldEnterTrade(
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number,
        currentPrices?: { upAsk: number; upBid: number; downAsk: number; downBid: number }
    ): { shouldTrade: boolean; direction: 'UP' | 'DOWN' | null; fairValue?: number; volatility?: number } {
        
        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  🛑 v2.0 GATE 0: SESSION LOCK CHECK (ABSOLUTE FIRST!)           ║
        // ║  If session is locked, NO trades allowed. Period.               ║
        // ╚══════════════════════════════════════════════════════════════════╝
        
        if (this.sessionState.isSessionLocked) {
            // Only log occasionally to avoid spam
            if (Math.random() < 0.05) {
                console.log(`🔒 SESSION LOCKED (${this.sessionState.lockReason}): P&L = $${this.sessionState.sessionPnL.toFixed(2)}`);
            }
            return { shouldTrade: false, direction: null };
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  🛑 THE ENFORCER - HARD PRICE GATES (v2.0: $0.65-$0.85)         ║
        // ║  These checks happen BEFORE anything else. No exceptions.        ║
        // ╚══════════════════════════════════════════════════════════════════╝
        
        // Determine direction first (needed to know which token to check)
        const distance = spotPrice - strikePrice;
        const direction = distance > 0 ? 'UP' : 'DOWN';
        
        // 🛑 ENFORCER GATE 1: HARD PRICE FLOOR ($0.65) - "Gamma Trap" Zone
        if (currentPrices) {
            const currentAsk = direction === 'UP' ? currentPrices.upAsk : currentPrices.downAsk;
            const currentBid = direction === 'UP' ? currentPrices.upBid : currentPrices.downBid;
            
            // Update price history for trend confirmation (do this every tick)
            this.updatePriceHistory(currentPrices.upBid, currentPrices.downBid);
            
            if (currentAsk > 0 && currentAsk < CONFIG.MIN_ENTRY_PRICE) {
                console.log(`⛔ REJECTED: Price $${currentAsk.toFixed(4)} is in KILL ZONE (< $${CONFIG.MIN_ENTRY_PRICE.toFixed(2)})`);
                return { shouldTrade: false, direction: null };
            }
            
            // 🛑 ENFORCER GATE 2: HARD PRICE CEILING ($0.85)
            if (currentAsk > 0 && currentAsk > CONFIG.MAX_ENTRY_PRICE) {
                console.log(`⛔ REJECTED: Price $${currentAsk.toFixed(4)} is too expensive (> $${CONFIG.MAX_ENTRY_PRICE.toFixed(2)})`);
                return { shouldTrade: false, direction: null };
            }
        }
        
        // ═══════════════════════════════════════════════════════════════════
        
        // Update volatility tracker with latest spot price
        this.quantEngine.updatePrice(spotPrice);

        // GATE: Check circuit breaker (cooldown after stop-loss)
        if (this.circuitBreaker.isCoolingDown) {
            const timeSinceStopLoss = Date.now() - this.circuitBreaker.lastStopLossTime;
            const timeRemaining = Math.max(0, CONFIG.MIN_COOLDOWN_MS - timeSinceStopLoss);
            console.log(`⏳ CIRCUIT BREAKER: Cooldown active - ${(timeRemaining / 1000).toFixed(1)}s left, ${this.circuitBreaker.stabilityCounter}/${CONFIG.STABILITY_TICKS_REQUIRED} ticks`);
            return { shouldTrade: false, direction: null };
        }

        // GATE: Trade rate limiter (prevent rapid-fire trading)
        const timeSinceLastTrade = Date.now() - this.circuitBreaker.lastTradeTime;
        if (this.circuitBreaker.lastTradeTime > 0 && timeSinceLastTrade < CONFIG.MIN_TRADE_INTERVAL_MS) {
            const waitTime = (CONFIG.MIN_TRADE_INTERVAL_MS - timeSinceLastTrade) / 1000;
            console.log(`⏳ RATE LIMIT: Wait ${waitTime.toFixed(1)}s before next trade`);
            return { shouldTrade: false, direction: null };
        }

        // GATE: Don't trade if we have pending trades (wait for previous pair to complete)
        if (this.hasPendingTrades()) {
            return { shouldTrade: false, direction: null };
        }

        // GATE: Time remaining must be > 150 seconds
        if (timeRemainingSeconds <= 150) {
            return { shouldTrade: false, direction: null };
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  v2.1: SIMPLIFIED - No trend confirmation, no fair value        ║
        // ║  Trust: price zone + tight stops + session limits               ║
        // ╚══════════════════════════════════════════════════════════════════╝
        
        /* DISABLED IN v2.1 - Trend confirmation was too restrictive
        const trendCheck = this.checkTrendConfirmation(direction);
        if (!trendCheck.confirmed) {
            console.log(`📊 TREND REJECTED: ${trendCheck.reason}`);
            return { shouldTrade: false, direction: null };
        }
        console.log(`📊 TREND CONFIRMED: ${trendCheck.reason}`);
        */

        /* DISABLED IN v2.1 - Fair value was causing bad entries (low vol moments before spikes)
        const volatility = this.quantEngine.getVolatilityPerMinute();
        const fairValue = this.quantEngine.calculateFairValue(
            spotPrice, 
            strikePrice, 
            timeRemainingSeconds, 
            volatility, 
            direction
        );

        if (fairValue < CONFIG.MIN_ENTRY_PRICE) {
            return { shouldTrade: false, direction: null, fairValue, volatility };
        }
        */

        // v2.1: Simple entry - if we passed all gates above, we trade
        console.log(`✅ v2.1 ENTRY: ${direction} @ price zone $${CONFIG.MIN_ENTRY_PRICE}-$${CONFIG.MAX_ENTRY_PRICE}`);
        return { shouldTrade: true, direction };
    }

    /**
     * Execute a trade: Buy 10% of available cash and immediately place sell order
     * Senior Quant v2.1: Uses FIXED profit target (no dynamic calculations)
     */
    async executeTrade(
        marketInfo: MarketConfig,
        spotPrice: number,
        strikePrice: number,
        direction: 'UP' | 'DOWN',
        fairValue: number = 0.0 // Legacy param, not used in v2.1
    ): Promise<{ buyOrderId: string; sellOrderId: string } | null> {
        // Prevent concurrent trade execution
        if (this.hasPendingTrades()) {
            console.log('⚠️ Skipping trade - pending trades exist or insufficient cash');
            return null;
        }

        // 🔄 Check circuit breaker one more time (double-check)
        if (this.circuitBreaker.isCoolingDown) {
            console.log('⚠️ Skipping trade - circuit breaker still active');
            return null;
        }

        this.isTradingLocked = true; // 🔒 LOCK ON

        try {
            const tokenId = direction === 'UP' ? marketInfo.upTokenId : marketInfo.downTokenId;
            
            // Get current price from order book
            const orderBook = await this.orderBookService.getOrderBook(tokenId);
            const buyPrice = orderBook.bestAsk; // Price to buy at (Ask)
            const currentBid = orderBook.bestBid; // Current Bid
            const spread = buyPrice - currentBid;

            if (buyPrice <= 0) {
                console.log(`⚠️ No valid buy price for ${direction} token`);
                this.isTradingLocked = false;
                return null;
            }

            // --- 🛡️ SENIOR QUANT v2.1 SIMPLIFIED RISK GATES ---
            // Just check spread - no dynamic calculations
            if (spread > CONFIG.MAX_ALLOWED_SPREAD) {
                console.log(`🛡️ REJECTED: Spread too wide $${spread.toFixed(4)} > $${CONFIG.MAX_ALLOWED_SPREAD.toFixed(2)}`);
                this.isTradingLocked = false;
                return null;
            }

            /* DISABLED IN v2.1 - Dynamic risk params were over-complicated
            const riskParams = this.calculateDynamicRisk(buyPrice, currentBid);
            if (!riskParams.isValid) {
                console.log(`🛡️ TRADE REJECTED: ${riskParams.rejectReason}`);
                this.isTradingLocked = false;
                return null;
            }
            */

            /* DISABLED IN v2.1 - Fair value check was causing bad entries
            if (fairValue > 0) {
                const edge = 0.05;
                const maxBuyPrice = fairValue - edge;
                if (buyPrice > maxBuyPrice) {
                    console.log(`🛡️ REJECTED: Price too high.`);
                    this.isTradingLocked = false;
                    return null;
                }
            }
            */

            // --- v2.1 FIXED RISK PARAMS ---
            const fixedProfitTarget = CONFIG.FIXED_PROFIT_TARGET;  // 2¢
            const fixedStopLoss = CONFIG.FIXED_STOP_LOSS;          // 4¢

            // Calculate size: 10% of available cash (configurable via TRADE_SIZE_PCT)
            const availableCash = this.executionGateway.getPaperCash();
            let tradeAmount = availableCash * CONFIG.TRADE_SIZE_PCT;
            
            // 🛡️ ENFORCE MINIMUM ORDER SIZE (Polymarket Requirement)
            if (tradeAmount < CONFIG.MIN_ORDER_SIZE) {
                if (availableCash >= CONFIG.MIN_ORDER_SIZE) {
                    console.log(`ℹ️ Scaling up trade amount to minimum: $${CONFIG.MIN_ORDER_SIZE.toFixed(2)}`);
                    tradeAmount = CONFIG.MIN_ORDER_SIZE;
                } else {
                    console.log(`⚠️ Insufficient cash for minimum trade. Need $${CONFIG.MIN_ORDER_SIZE.toFixed(2)}, have $${availableCash.toFixed(2)}`);
                    this.isTradingLocked = false; 
                    return null;
                }
            }
            
            const buySize = tradeAmount / buyPrice;

            // Round to 4 decimal places for precision
            const roundedBuyPrice = Math.round(buyPrice * 10000) / 10000;
            const roundedBuySize = Math.round(buySize * 10000) / 10000;
            const finalBuyAmount = roundedBuyPrice * roundedBuySize;

            // Check if buy price >= 0.99 (can't sell at 1.01, so only buy)
            const shouldPlaceSell = buyPrice < 0.99;

            // 🎯 v2.1 FIXED PROFIT TARGET
            const sellPrice = Math.round((roundedBuyPrice + fixedProfitTarget) * 10000) / 10000;
            const cappedSellPrice = Math.min(sellPrice, 0.99); // Cap at $0.99

            console.log('');
            console.log('💰 ════════════════════════════════════════');
            console.log('💰 SENIOR QUANT v2.1 - EXECUTING TRADE');
            console.log('💰 ════════════════════════════════════════');
            console.log(`   Direction: ${direction}`);
            console.log(`   Spread: $${spread.toFixed(4)}`);
            console.log('   --- v2.1 FIXED PARAMS ---');
            console.log(`   Profit Target: +$${fixedProfitTarget.toFixed(2)} (FIXED)`);
            console.log(`   Stop Loss: -$${fixedStopLoss.toFixed(2)} (FIXED)`);
            console.log(`   Breakeven at: +$${CONFIG.BREAKEVEN_TRIGGER.toFixed(3)}`);
            console.log('   --- EXECUTION ---');
            console.log(`   Trade Amount: $${tradeAmount.toFixed(2)} (${(CONFIG.TRADE_SIZE_PCT * 100).toFixed(0)}% of $${availableCash.toFixed(2)})`);
            console.log(`   Buy Price: $${roundedBuyPrice.toFixed(4)}`);
            console.log(`   Buy Size: ${roundedBuySize.toFixed(4)} shares`);

            // Place buy order as FOK (Fill-Or-Kill) for immediate execution
            let buyOrderId: string;
            try {
                buyOrderId = await this.executionGateway.placeFOKOrder(
                    tokenId,
                    'BUY',
                    finalBuyAmount,
                    roundedBuyPrice
                );
                
                if (!buyOrderId) {
                    console.log(`⚠️ FOK buy order failed or was killed`);
                    this.isTradingLocked = false;
                    return null;
                }
            } catch (error: any) {
                console.error(`❌ FOK buy order error:`, error.message);
                this.isTradingLocked = false;
                return null;
            }

            // 🔧 Record trade time for rate limiting
            this.circuitBreaker.lastTradeTime = Date.now();

            // Record buy order (mark as FILLED since FOK executes immediately or fails)
            // Store the dynamic stop distance for later use
            const buyRecord: TradeRecord = {
                id: `trade_${this.orderCounter++}`,
                timestamp: Date.now(),
                marketSlug: marketInfo.eventSlug,
                side: 'BUY',
                tokenId,
                tokenType: direction,
                price: roundedBuyPrice,
                size: roundedBuySize,
                orderId: buyOrderId,
                status: 'FILLED'
            };

            // Store fixed stop distance for later reference
            (buyRecord as any).fixedStopDist = fixedStopLoss;

            this.tradeRecords.set(buyRecord.id, buyRecord);
            this.activePositions.set(buyRecord.id, buyRecord);

            let sellOrderId: string | null = null;

            // Only place sell order if buy price < 0.99
            if (shouldPlaceSell) {
                console.log(`   Sell Price: $${cappedSellPrice.toFixed(4)} (FIXED +$${fixedProfitTarget.toFixed(2)})`);
                console.log(`   Sell Size: ${roundedBuySize.toFixed(4)} shares`);
                console.log(`   Expected Profit: $${(fixedProfitTarget * roundedBuySize).toFixed(4)}`);

                // Place sell order as GTC (Good-Til-Cancelled) limit order
                sellOrderId = await this.executionGateway.placeLimitOrder(
                    tokenId,
                    'SELL',
                    cappedSellPrice,
                    roundedBuySize,
                    'GTC'
                );

                const sellRecord: TradeRecord = {
                    id: `trade_${this.orderCounter++}`,
                    timestamp: Date.now(),
                    marketSlug: marketInfo.eventSlug,
                    side: 'SELL',
                    tokenId,
                    tokenType: direction,
                    price: cappedSellPrice,
                    size: roundedBuySize,
                    orderId: sellOrderId || `sell_pending_${Date.now()}`,
                    status: sellOrderId ? 'PENDING' : 'CANCELLED',
                    pairedWith: buyRecord.id,
                    exitType: 'LIMIT'
                };

                this.tradeRecords.set(sellRecord.id, sellRecord);
                
                if (sellOrderId) {
                    console.log('💰 ────────────────────────────────────────');
                    console.log(`   ✅ Buy (FOK): ${buyOrderId} - FILLED`);
                    console.log(`   ✅ Sell (GTC): ${sellOrderId} - PENDING @ $${cappedSellPrice.toFixed(4)}`);
                    console.log(`   🛡️ Stop Loss: $${(roundedBuyPrice - fixedStopLoss).toFixed(4)} (FIXED -$${fixedStopLoss.toFixed(2)})`);
                    console.log('💰 ════════════════════════════════════════');
                }
            } else {
                console.log(`   ✅ Buy order placed (NO SELL - price >= 0.99)`);
                console.log(`   ⚠️ Holding position for settlement`);
                console.log('💰 ========================================');
                this.isTradingLocked = false; 
            }

            return { buyOrderId, sellOrderId: sellOrderId || '' };
        } catch (error: any) {
            console.error(`❌ Error executing trade:`, error.message);
            this.isTradingLocked = false;
            return null;
        }
    }

    /**
     * Check for filled orders, update status, and manage active positions
     * Senior Quant v2.0: Trailing stop (breakeven), session P&L tracking
     * @param timeRemainingSeconds - Time remaining in the market (for hold-to-maturity logic)
     */
    async updateOrderStatus(timeRemainingSeconds?: number, spotPrice?: number): Promise<void> {
        // Get all paper orders from execution gateway
        const paperOrders = this.executionGateway.getPaperOrders();
        const allPositions = this.executionGateway.getAllPaperPositions();

        // 🔄 PHASE 1: CIRCUIT BREAKER STABILITY CHECK
        // If we're in cooldown, check if market has stabilized
        if (this.circuitBreaker.isCoolingDown && this.circuitBreaker.crashTokenId) {
            try {
                const orderBook = await this.orderBookService.getOrderBook(this.circuitBreaker.crashTokenId);
                const currentBid = orderBook.bestBid;
                
                // Run circuit breaker check (this updates internal state)
                await this.checkCircuitBreaker(currentBid);
            } catch (error) {
                console.log(`⚠️ Could not check circuit breaker stability: ${error}`);
            }
        }

        // 🛡️ PHASE 2: POSITION MONITORING (Stop Loss + Trailing Stop)
        const activePositionsList = Array.from(this.activePositions.values());

        if (activePositionsList.length === 0) {
            return;
        }

        console.log(`🛡️ Monitoring ${activePositionsList.length} position(s)...`);

        for (const activePosition of activePositionsList) {
            try {
                // Fetch current bid price for our position
                const orderBook = await this.orderBookService.getOrderBook(activePosition.tokenId);
                const currentBid = orderBook.bestBid;
                const currentAsk = orderBook.bestAsk;
                const entryPrice = activePosition.price;
                
                // 🎯 v2.1 FIXED STOP LOSS
                // Use stored fixed stop distance, or default from config
                let stopDistance: number;
                if ((activePosition as any).fixedStopDist) {
                    stopDistance = (activePosition as any).fixedStopDist;
                } else {
                    // Fallback: use config fixed stop
                    stopDistance = CONFIG.FIXED_STOP_LOSS;
                }
                
                // ╔══════════════════════════════════════════════════════════════════╗
                // ║  🎯 v2.0 TRAILING STOP: BREAKEVEN TRIGGER                       ║
                // ║  Once we're +2¢ in profit, move stop to entry price             ║
                // ╚══════════════════════════════════════════════════════════════════╝
                
                const currentProfit = currentBid - entryPrice;
                const breakEvenTriggered = (activePosition as any).breakEvenTriggered || false;
                
                // Check if we should trigger breakeven
                if (!breakEvenTriggered && currentProfit >= CONFIG.BREAKEVEN_TRIGGER) {
                    // Move stop to breakeven (entry price)
                    (activePosition as any).breakEvenTriggered = true;
                    (activePosition as any).fixedStopDist = 0; // Stop at entry = 0 distance
                    stopDistance = 0;
                    
                    console.log('');
                    console.log('🎯 ════════════════════════════════════════');
                    console.log('🎯   BREAKEVEN TRIGGERED!');
                    console.log(`🎯   Entry: $${entryPrice.toFixed(4)}`);
                    console.log(`🎯   Current: $${currentBid.toFixed(4)} (+$${currentProfit.toFixed(4)})`);
                    console.log('🎯   Stop moved to ENTRY PRICE (risk-free trade)');
                    console.log('🎯 ════════════════════════════════════════');
                    console.log('');
                }
                
                const stopLossPrice = entryPrice - stopDistance;
                const stopType = breakEvenTriggered ? 'BREAKEVEN' : 'FIXED';

                console.log(`   📊 Position: Token ${activePosition.tokenId.substring(0, 8)}...`);
                console.log(`      Entry: $${entryPrice.toFixed(4)}, Bid: $${currentBid.toFixed(4)}, ${stopType} SL: $${stopLossPrice.toFixed(4)}`);

                // 🛡️ TRIGGER STOP LOSS
                if (currentBid > 0 && currentBid < stopLossPrice) {
                    const isBreakeven = breakEvenTriggered && currentBid >= entryPrice - 0.005; // Small tolerance
                    
                    console.log('');
                    console.log('🚨 ════════════════════════════════════════');
                    console.log(`🚨 ${isBreakeven ? 'BREAKEVEN EXIT' : 'STOP LOSS TRIGGERED'}`);
                    console.log('🚨 ════════════════════════════════════════');
                    console.log(`   Entry: $${entryPrice.toFixed(4)}`);
                    console.log(`   Current Bid: $${currentBid.toFixed(4)}`);
                    console.log(`   Stop Threshold: $${stopLossPrice.toFixed(4)}`);

                    // 1. Cancel any pending sell orders first
                    const pendingSell = Array.from(this.tradeRecords.values()).find(r =>
                        r.pairedWith === activePosition.id && r.side === 'SELL' && r.status === 'PENDING'
                    );

                    if (pendingSell) {
                        console.log(`   🗑️ Cancelling limit sell order ${pendingSell.orderId}...`);
                        await this.executionGateway.cancelOrder(pendingSell.orderId);
                        pendingSell.status = 'CANCELLED';
                    }

                    // 2. Execute Emergency Sell (FAK at Bid - $0.02)
                    const exitPrice = Math.max(0.01, currentBid - 0.02);
                    const exitSize = activePosition.size;

                    console.log(`   💥 FAK Exit @ $${exitPrice.toFixed(4)} (Bid $${currentBid.toFixed(4)} - $0.02)`);

                    const sold = await this.executionGateway.executeFAK(
                        activePosition.tokenId,
                        'SELL',
                        exitPrice,
                        exitSize
                    );

                    if (sold) {
                        // Create stop-loss trade record
                        const stopLossRecord: TradeRecord = {
                            id: `trade_${this.orderCounter++}`,
                            timestamp: Date.now(),
                            marketSlug: activePosition.marketSlug,
                            side: 'SELL',
                            tokenId: activePosition.tokenId,
                            tokenType: activePosition.tokenType,
                            price: exitPrice,
                            size: exitSize,
                            orderId: `${isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS'}_${Date.now()}`,
                            status: 'FILLED',
                            pairedWith: activePosition.id,
                            exitType: isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS'
                        };
                        
                        this.tradeRecords.set(stopLossRecord.id, stopLossRecord);
                        this.activePositions.delete(activePosition.id);
                        
                        const pnl = (exitPrice - entryPrice) * exitSize;
                        console.log(`   ✅ ${isBreakeven ? 'Breakeven' : 'Stop loss'} executed: ${stopLossRecord.id}`);
                        console.log(`   📉 P&L: $${pnl.toFixed(2)}`);

                        // 📈 UPDATE SESSION P&L (v2.0)
                        this.updateSessionPnL(pnl);

                        // 🔄 TRIGGER CIRCUIT BREAKER (only for actual losses, not breakeven)
                        if (!isBreakeven) {
                            this.triggerCircuitBreaker(activePosition.tokenId, currentBid);
                        }
                        
                    } else {
                        console.error(`   ❌ Stop loss execution FAILED!`);
                    }

                    this.isTradingLocked = false;
                    console.log('🚨 ════════════════════════════════════════');
                    continue;
                } else if (currentBid > 0) {
                    // Log profit/loss status
                    if (currentProfit > 0) {
                        console.log(`      ✅ In profit: +$${currentProfit.toFixed(4)}${breakEvenTriggered ? ' (RISK-FREE)' : ''}`);
                    } else {
                        const distanceToStopLoss = currentBid - stopLossPrice;
                        if (distanceToStopLoss < 0.03 && distanceToStopLoss > 0) {
                            console.log(`      ⚠️ CLOSE TO STOP: $${distanceToStopLoss.toFixed(4)} away`);
                        }
                    }
                }

                // --- HOLD TO MATURITY CHECK ---
                if (timeRemainingSeconds !== undefined && timeRemainingSeconds < 45 && currentBid > 0.94) {
                    const pendingSell = Array.from(this.tradeRecords.values()).find(r =>
                        r.pairedWith === activePosition.id && r.side === 'SELL' && r.status === 'PENDING'
                    );

                    if (pendingSell) {
                        console.log(`💎 HOLD TO MATURITY: ${timeRemainingSeconds.toFixed(0)}s left, deep ITM (Bid: $${currentBid.toFixed(2)})`);
                        console.log(`   Cancelling sell @ $${pendingSell.price.toFixed(4)} to capture $1.00`);
                        await this.executionGateway.cancelOrder(pendingSell.orderId);
                        pendingSell.status = 'CANCELLED';
                        pendingSell.exitType = 'HOLD_TO_MATURITY';
                        this.isTradingLocked = false;
                    }
                }
            } catch (error: any) {
                console.error(`❌ Error checking position: ${error.message || error}`);
            }
        }

        // Update trade records based on paper trading state
        for (const [tradeId, record] of this.tradeRecords.entries()) {
            if (record.status === 'PENDING') {
                const isFilled = await this.executionGateway.isOrderFilled(record.orderId);
                
                if (isFilled) {
                    record.status = 'FILLED';
                    console.log(`✅ ${record.side} order filled: ${record.orderId}`);

                    if (record.side === 'BUY') {
                        // Mark as active position for tracking
                        this.activePositions.set(record.id, record);
                    } else if (record.side === 'SELL') {
                        // Find and clear the paired buy order from active positions
                        if (record.pairedWith) {
                            // Calculate P&L for this completed trade
                            const buyOrder = this.tradeRecords.get(record.pairedWith);
                            if (buyOrder) {
                                const pnl = (record.price - buyOrder.price) * record.size;
                                console.log(`   💰 Trade P&L: $${pnl.toFixed(2)}`);
                                
                                // 📈 UPDATE SESSION P&L (v2.0)
                                this.updateSessionPnL(pnl);
                            }
                            
                            this.activePositions.delete(record.pairedWith);
                        }
                        
                        // 🔓 UNLOCK AFTER SELL FILL
                        this.isTradingLocked = false;
                        console.log(`🔓 Trading unlocked - ready for next opportunity`);
                    }
                }
            }
        }
    }

    /**
     * Get strategy statistics with Mark-to-Market PNL calculations
     * @param currentPrices - Current market prices for valuation
     */
    getStats(currentPrices?: { upBid: number; downBid: number }): StrategyStats {
        const records = Array.from(this.tradeRecords.values());
        
        const buyOrders = records.filter(r => r.side === 'BUY');
        const sellOrders = records.filter(r => r.side === 'SELL');
        const executedBuys = buyOrders.filter(r => r.status === 'FILLED');
        const executedSells = sellOrders.filter(r => r.status === 'FILLED');
        
        // 🔧 NEW: Count sell orders by exit type
        const stopLossExits = sellOrders.filter(r => r.status === 'FILLED' && r.exitType === 'STOP_LOSS').length;
        const limitSellFills = sellOrders.filter(r => r.status === 'FILLED' && r.exitType === 'LIMIT').length;
        const cancelledSells = sellOrders.filter(r => r.status === 'CANCELLED').length;
        
        // Calculate total invested (all filled buy orders)
        const totalInvested = executedBuys.reduce((sum, buy) => {
            return sum + (buy.price * buy.size);
        }, 0);

        // Calculate total proceeds (all filled sell orders)
        const totalProceeds = executedSells.reduce((sum, sell) => {
            return sum + (sell.price * sell.size);
        }, 0);

        // Calculate realized PNL (completed trades where both buy and sell filled)
        let realizedPNL = 0;
        executedBuys.forEach(buy => {
            const pairedSell = sellOrders.find(s => s.pairedWith === buy.id && s.status === 'FILLED');
            if (pairedSell) {
                const buyCost = buy.price * buy.size;
                const sellProceeds = pairedSell.price * pairedSell.size;
                realizedPNL += (sellProceeds - buyCost);
            }
        });

        // Calculate unrealized PNL (naked positions - bought but not sold)
        // Mark-to-Market: value based on current best bid price
        // 🔧 FIX: Look specifically for a FILLED sell, not just any sell with pairedWith
        // This handles the case where a limit sell is CANCELLED but a stop-loss sell is FILLED
        const nakedPositions = executedBuys.filter(buy => {
            const filledSell = sellOrders.find(s => s.pairedWith === buy.id && s.status === 'FILLED');
            return !filledSell;  // Naked only if NO filled sell is paired with this buy
        });

        let unrealizedPNL = 0;
        nakedPositions.forEach(pos => {
            const buyCost = pos.price * pos.size;
            
            // Determine current market value (Mark-to-Market)
            let marketValue = 0;
            if (currentPrices) {
                const currentBid = pos.tokenType === 'UP' ? currentPrices.upBid : currentPrices.downBid;
                if (currentBid > 0) {
                    marketValue = currentBid * pos.size;
                } else {
                    // Fallback to buy price if no bid (very conservative)
                    marketValue = pos.price * pos.size;
                }
            } else {
                // Fallback if prices not provided
                marketValue = pos.price * pos.size;
            }
            
            unrealizedPNL += (marketValue - buyCost);
        });

        // Net PNL = realized + unrealized
        const netPNL = realizedPNL + unrealizedPNL;

        return {
            totalBuyOrders: buyOrders.length,
            totalSellOrders: sellOrders.length,
            executedBuyOrders: executedBuys.length,
            executedSellOrders: executedSells.length,
            stopLossExits,
            limitSellFills,
            cancelledSells,
            nakedPositions: nakedPositions.length,
            totalTrades: records.length,
            totalInvested,
            totalProceeds,
            netPNL,
            realizedPNL,
            unrealizedPNL
        };
    }

    /**
     * Get all trade records
     */
    getTradeRecords(): TradeRecord[] {
        return Array.from(this.tradeRecords.values());
    }

    /**
     * Get active positions (bought but not sold)
     */
    getActivePositions(): TradeRecord[] {
        return Array.from(this.activePositions.values());
    }

    /**
     * Reset stats for new market
     * Senior Quant v2.0: Resets circuit breaker, session state, and price history
     */
    async resetForNewMarket(): Promise<void> {
        console.log('🔄 Resetting Senior Quant v2.0 for new market...');
        
        // Clear active positions tracking
        const positionCount = this.activePositions.size;
        this.activePositions.clear();
        
        // Clear all trade records from previous market
        const recordCount = this.tradeRecords.size;
        this.tradeRecords.clear();
        
        // Reset lock
        this.isTradingLocked = false;
        
        // 🔄 RESET CIRCUIT BREAKER
        const wasCoolingDown = this.circuitBreaker.isCoolingDown;
        this.circuitBreaker = {
            isCoolingDown: false,
            crashLowPrice: 0,
            stabilityCounter: 0,
            lastStopLossTime: 0,
            crashTokenId: '',
            lastTradeTime: 0
        };
        
        // 📈 RESET SESSION STATE (v2.0) - NEW session for new market
        const previousSessionPnL = this.sessionState.sessionPnL;
        const previousSessionLocked = this.sessionState.isSessionLocked;
        this.sessionState = {
            sessionPnL: 0,
            sessionStartTime: Date.now(),
            isSessionLocked: false,
            lockReason: null,
            tradesThisSession: 0
        };
        
        // 📊 RESET PRICE HISTORY (v2.0)
        this.priceHistory = {
            upBids: [],
            downBids: [],
            maxSize: CONFIG.TREND_LOOKBACK_TICKS
        };
        
        if (positionCount > 0 || recordCount > 0 || wasCoolingDown || previousSessionLocked) {
            console.log(`   Cleared ${positionCount} positions, ${recordCount} trade records`);
            if (wasCoolingDown) {
                console.log(`   🔓 Circuit breaker reset for new market`);
            }
            if (previousSessionPnL !== 0) {
                console.log(`   📈 Previous session P&L: $${previousSessionPnL.toFixed(2)}`);
            }
            if (previousSessionLocked) {
                console.log(`   🔓 Session lock cleared for new market`);
            }
        }
        
        console.log(`   📊 Fresh session started - price history cleared`);
        
        // Also clear execution gateway state (handles both paper and live)
        await this.executionGateway.clearAllState();
    }
}

