
/**
 * Execution Gateway Module
 * The Hand: Handles Real Orders vs. Paper Simulations
 * ⚠️ CRITICAL FIX: Now accepts dynamic tokenId parameter
 */

import { Side, OrderType as PolyOrderType } from '@polymarket/clob-client';
import { CONFIG } from './config';
import { createClobClient } from './clobClientFactory';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

export interface Order {
    id: string;
    tokenId: string;  // ⚠️ Track which token this order is for
    side: OrderSide;
    price: number;
    size: number;
    timestamp: number;
}

export interface Position {
    tokenId: string;  // ⚠️ Track which token we're holding
    shares: number;
    entryPrice: number;
    entryTime: number;
}

export interface TradeRecord {
    id: string;
    timestamp: number;
    marketSlug: string;
    side: 'BUY' | 'SELL';
    tokenId: string;
    tokenType: 'UP' | 'DOWN';
    price: number;
    size: number;
    orderId: string;
    status: 'PENDING' | 'FILLED' | 'CANCELLED';
    pairedWith?: string; // ID of the paired order (buy paired with sell)
    exitType?: 'LIMIT' | 'STOP_LOSS' | 'HOLD_TO_MATURITY' | 'BREAKEVEN'; // How the position was exited (for SELL orders)
}

export class ExecutionGateway {
    private clobClient: Awaited<ReturnType<typeof createClobClient>> | null = null;

    // Paper Trading State
    private paperCash: number = CONFIG.BANKROLL; // Initial capital from config
    private paperPositions: Map<string, Position> = new Map(); // tokenId -> Position
    private paperOrders: Map<string, Order> = new Map();
    private filledPaperOrders: Set<string> = new Set(); // Track filled order IDs
    private paperOrderCounter: number = 0;
    private isExecutingTrade: boolean = false; // Lock to prevent concurrent trades

    constructor() {
        console.log('⚡ Execution Gateway initialized');
        console.log(`💼 Mode: ${CONFIG.PAPER_TRADE ? 'PAPER' : 'LIVE'}`);
        if (CONFIG.PAPER_TRADE) {
            console.log(`💵 Paper Cash: $${this.paperCash.toFixed(2)}`);
        }
    }

    /**
     * Initialize ClobClient (async initialization)
     */
    private async ensureClobClient(): Promise<void> {
        if (!this.clobClient) {
            this.clobClient = await createClobClient();
        }
    }

    /**
     * 🔵 PLACE ORDER ROUTER
     * Routes orders to paper or live execution
     * ⚠️ CRITICAL FIX: Now accepts tokenId parameter
     */
    async placeLimitOrder(tokenId: string, side: OrderSide, price: number, size: number, orderType: OrderType = 'GTC'): Promise<string> {

        if (CONFIG.PAPER_TRADE) {
            return this.placePaperOrder(tokenId, side, price, size, orderType);
        } else {
            return this.placeLiveOrder(tokenId, side, price, size, orderType);
        }
    }

    /**
     * 🔵 PLACE FOK MARKET ORDER (Fill-Or-Kill)
     * For immediate execution - must fill entirely or cancel
     */
    async placeFOKOrder(tokenId: string, side: OrderSide, amount: number, price?: number): Promise<string> {
        if (CONFIG.PAPER_TRADE) {
            // Prevent concurrent execution
            if (this.isExecutingTrade) {
                throw new Error('Trade already in progress - please wait');
            }
            
        this.isExecutingTrade = true;
        try {
            // For paper trading, simulate FOK as immediate execution
            // Calculate size from amount
            const size = side === 'BUY' ? amount / (price || 0.5) : amount;
            const executed = this.executePaperFAK(tokenId, side, price || 0.5, size);
            if (executed) {
                const orderId = `PAPER_FOK_${this.paperOrderCounter++}`;
                // 🔧 FIX: Do NOT add FOK orders to paperOrders!
                // FOK orders execute immediately in executePaperFAK() and should not be 
                // re-processed by checkPaperFills(). Adding them to paperOrders caused
                // double-deduction of cash when checkPaperFills saw them on the next tick.
                // Instead, add to filledPaperOrders so isOrderFilled() works correctly.
                this.filledPaperOrders.add(orderId);
                return orderId;
            }
            throw new Error('FOK order failed - insufficient funds or no position');
        } finally {
            this.isExecutingTrade = false;
        }
        } else {
            await this.ensureClobClient();
            const response = await this.clobClient!.createAndPostMarketOrder({
                tokenID: tokenId,
                amount: amount,
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                price: price,
                feeRateBps: 0,
            }, undefined, PolyOrderType.FOK);
            return response.orderID;
        }
    }

    /**
     * 🔵 CANCEL ORDER ROUTER
     */
    async cancelOrder(orderId: string): Promise<boolean> {

        if (CONFIG.PAPER_TRADE) {
            return this.cancelPaperOrder(orderId);
        } else {
            return this.cancelLiveOrder(orderId);
        }
    }

    /**
     * 🔵 FAK (FILL AND KILL) EMERGENCY ROUTER
     * For immediate execution at market price
     */
    async executeFAK(tokenId: string, side: OrderSide, price: number, size: number): Promise<boolean> {

        if (CONFIG.PAPER_TRADE) {
            return this.executePaperFAK(tokenId, side, price, size);
        } else {
            return this.executeLiveFAK(tokenId, side, price, size);
        }
    }

    /**
     * 🧪 PAPER TRADING: Place Order
     */
    private placePaperOrder(tokenId: string, side: OrderSide, price: number, size: number, type: OrderType): string {
        const orderId = `PAPER_${this.paperOrderCounter++}`;

        const order: Order = {
            id: orderId,
            tokenId,
            side,
            price,
            size,
            timestamp: Date.now()
        };

        this.paperOrders.set(orderId, order);
        console.log(`[PAPER] 📝 Placed ${side} LIMIT @ ${price.toFixed(2)} (Token: ${tokenId.substring(0, 8)}..., Size: ${size})`);

        return orderId;
    }

    /**
     * 🧪 PAPER TRADING: Cancel Order
     */
    private cancelPaperOrder(orderId: string): boolean {
        if (this.paperOrders.has(orderId)) {
            this.paperOrders.delete(orderId);
            console.log(`[PAPER] 🗑️ Cancelled Order ${orderId}`);
            return true;
        }
        console.warn(`[PAPER] ⚠️ Order ${orderId} not found`);
        return false;
    }

    /**
     * 🧪 PAPER TRADING: Execute FAK (Fill and Kill)
     */
    private executePaperFAK(tokenId: string, side: OrderSide, price: number, size: number): boolean {
        console.log(`[PAPER] 💥 FAK EXECUTED: ${side} @ ${price.toFixed(4)} (Token: ${tokenId.substring(0, 8)}..., Size: ${size.toFixed(6)})`);

        if (side === 'BUY') {
            const cost = price * size;
            const cashBefore = this.paperCash;
            if (this.paperCash >= cost) {
                this.paperCash -= cost;

                // Update or create position
                const existing = this.paperPositions.get(tokenId);
                if (existing) {
                    const totalShares = existing.shares + size;
                    const avgPrice = ((existing.entryPrice * existing.shares) + (price * size)) / totalShares;
                    this.paperPositions.set(tokenId, {
                        tokenId,
                        shares: totalShares,
                        entryPrice: avgPrice,
                        entryTime: Date.now()
                    });
                } else {
                    this.paperPositions.set(tokenId, {
                        tokenId,
                        shares: size,
                        entryPrice: price,
                        entryTime: Date.now()
                    });
                }

                console.log(`[PAPER] ✅ Bought ${size.toFixed(6)} shares @ ${price.toFixed(4)}`);
                console.log(`[PAPER] 💰 Cash: $${cashBefore.toFixed(2)} → $${this.paperCash.toFixed(2)} (-$${cost.toFixed(2)})`);
                return true;
            } else {
                console.error(`[PAPER] ❌ Insufficient cash. Need $${cost.toFixed(2)}, have $${this.paperCash.toFixed(2)}`);
                return false;
            }
        } else {
            // SELL
            const position = this.paperPositions.get(tokenId);
            console.log(`[PAPER] 🔍 Checking position for token ${tokenId.substring(0, 8)}...: ${position ? `Found ${position.shares.toFixed(6)} shares` : 'No position found'}`);

            if (position && position.shares >= size) {
                const proceeds = price * size;
                this.paperCash += proceeds;
                const pnl = (price - position.entryPrice) * size;
                console.log(`[PAPER] ✅ Sold ${size.toFixed(6)} shares @ ${price.toFixed(4)}. P&L: $${pnl.toFixed(2)}. Cash: $${this.paperCash.toFixed(2)}`);

                if (position.shares - size < 0.000001) { // Use small epsilon for floating point comparison
                    this.paperPositions.delete(tokenId);
                } else {
                    position.shares -= size;
                }
                return true;
            } else {
                console.error(`[PAPER] ❌ No position to sell or wrong token. Position: ${position ? position.shares.toFixed(6) : 'null'}, Required: ${size.toFixed(6)}`);
                return false;
            }
        }
    }

    /**
     * 🧪 SIMULATOR HELPER: Check if paper orders should fill
     * ⚠️ CRITICAL FIX: Now checks tokenId match
     */
    checkPaperFills(tokenId: string, currentBestAsk: number, currentBestBid: number): Position | null {
        for (const [orderId, order] of this.paperOrders.entries()) {
            // Only check orders for the correct token
            if (order.tokenId !== tokenId) continue;
            
            // 🔧 SAFEGUARD: Skip orders that are already marked as filled
            // This prevents double-processing in case of any edge cases
            if (this.filledPaperOrders.has(orderId)) {
                console.warn(`[PAPER] ⚠️ Skipping already-filled order ${orderId}`);
                this.paperOrders.delete(orderId);
                continue;
            }

            let filled = false;

            // Guard: if order book side is empty, bestAsk/bid may be reported as 0.
            // Never fill on 0 because that would create fake fills.
            if (order.side === 'BUY' && currentBestAsk > 0 && currentBestAsk <= order.price) {
                // Our buy limit was hit by the market coming down
                filled = true;
                // Fill at the best ask (realistic), but never worse than our limit price
                const fillPrice = Math.min(currentBestAsk, order.price);
                const cost = fillPrice * order.size;
                this.paperCash -= cost;
                
                // Update or create position
                const existing = this.paperPositions.get(tokenId);
                if (existing) {
                    const totalShares = existing.shares + order.size;
                    const avgPrice = ((existing.entryPrice * existing.shares) + (fillPrice * order.size)) / totalShares;
                    const updated = {
                        tokenId: order.tokenId,
                        shares: totalShares,
                        entryPrice: avgPrice,
                        entryTime: Date.now()
                    };
                    this.paperPositions.set(tokenId, updated);
                } else {
                    const newPos = {
                        tokenId: order.tokenId,
                        shares: order.size,
                        entryPrice: fillPrice,
                        entryTime: Date.now()
                    };
                    this.paperPositions.set(tokenId, newPos);
                }
                
                console.log(`[PAPER] 🔔 BUY ORDER FILLED @ ${fillPrice.toFixed(4)} (limit $${order.price.toFixed(4)}). Cash: $${this.paperCash.toFixed(2)}`);
            } else if (order.side === 'SELL' && currentBestBid > 0 && currentBestBid >= order.price) {
                // Our sell limit was hit by the market coming up
                filled = true;
                // Fill at the best bid (realistic), but never better than our limit price
                const fillPrice = Math.max(currentBestBid, order.price);
                const proceeds = fillPrice * order.size;
                const cashBefore = this.paperCash;
                this.paperCash += proceeds;
                
                const position = this.paperPositions.get(tokenId);
                if (position) {
                    const pnl = (fillPrice - position.entryPrice) * order.size;
                    console.log(`[PAPER] 🔔 SELL ORDER FILLED @ ${fillPrice.toFixed(4)} (limit $${order.price.toFixed(4)}). P&L: $${pnl.toFixed(2)}.`);
                    console.log(`[PAPER] 💰 Cash: $${cashBefore.toFixed(2)} → $${this.paperCash.toFixed(2)} (+$${proceeds.toFixed(2)})`);
                    
                    if (position.shares <= order.size) {
                        this.paperPositions.delete(tokenId);
                        console.log(`[PAPER] 🔓 Position closed - all shares sold`);
                    } else {
                        position.shares -= order.size;
                    }
                }
            } else if (order.side === 'SELL' && currentBestBid > 0) {
                // Log why sell order isn't filling (for debugging)
                const gap = order.price - currentBestBid;
                if (gap > 0.01) { // Only log if gap is significant (>1 cent)
                    // Only log occasionally to avoid spam (every 10th check or so)
                    if (Math.random() < 0.1) {
                        console.log(`[PAPER] ⏳ SELL @ $${order.price.toFixed(4)} waiting for bid to reach (current: $${currentBestBid.toFixed(4)}, gap: $${gap.toFixed(4)})`);
                    }
                }
            }

            if (filled) {
                this.filledPaperOrders.add(orderId); // Mark as filled
                this.paperOrders.delete(orderId);
                return this.paperPositions.get(tokenId) || null;
            }
        }

        return null;
    }

    /**
     * 💸 LIVE TRADING: Place Order
     * ⚠️ CRITICAL FIX: Now uses tokenId parameter instead of CONFIG.MARKET_ID
     */
    private async placeLiveOrder(tokenId: string, side: OrderSide, price: number, size: number, type: OrderType): Promise<string> {
        console.log(`[LIVE] 💸 SIGNING TRANSACTION: ${side} @ ${price.toFixed(2)} (Token: ${tokenId.substring(0, 8)}...) | Type: ${type}`);

        try {
            await this.ensureClobClient();

            // Map OrderType to Polymarket OrderType
            const polyOrderType = type === 'GTC' ? PolyOrderType.GTC 
                : type === 'GTD' ? PolyOrderType.GTD 
                : type === 'FOK' ? PolyOrderType.FOK 
                : PolyOrderType.FAK;

            // For FOK/FAK, use market order
            if (type === 'FOK' || type === 'FAK') {
                const marketOrderType = type === 'FOK' ? PolyOrderType.FOK : PolyOrderType.FAK;
                const response = await this.clobClient!.createAndPostMarketOrder({
                    tokenID: tokenId,
                    amount: side === 'BUY' ? price * size : size, // For BUY: dollar amount, for SELL: shares
                    side: side === 'BUY' ? Side.BUY : Side.SELL,
                    price: price,
                    feeRateBps: 0,
                }, undefined, marketOrderType);
                console.log(`[LIVE] ✅ ${type} Order placed. ID: ${response.orderID}`);
                return response.orderID;
            } else {
                // For GTC/GTD, use limit order
                const limitOrderType = type === 'GTC' ? PolyOrderType.GTC : PolyOrderType.GTD;
                const response = await this.clobClient!.createAndPostOrder({
                    tokenID: tokenId,
                    price: price,
                    side: side === 'BUY' ? Side.BUY : Side.SELL,
                    size: size,
                    feeRateBps: 0,
                }, undefined, limitOrderType);
                console.log(`[LIVE] ✅ ${type} Order placed. ID: ${response.orderID}`);
                return response.orderID;
            }

        } catch (error) {
            console.error(`[LIVE] ❌ Error placing order:`, error);
            throw error;

        }
    }

    /**
     * 💸 LIVE TRADING: Cancel Order
     */
    private async cancelLiveOrder(orderId: string): Promise<boolean> {
        console.log(`[LIVE] 📡 Sending Cancel Request for ${orderId}`);

        try {
            await this.ensureClobClient();
            await this.clobClient!.cancelOrder({ orderID: orderId });
            console.log(`[LIVE] ✅ Order cancelled`);
            return true;
        } catch (error) {
            console.error(`[LIVE] ❌ Error cancelling order:`, error);
            return false;
        }
    }

    /**
     * 💸 LIVE TRADING: Execute FAK
     */
    private async executeLiveFAK(tokenId: string, side: OrderSide, price: number, size: number): Promise<boolean> {
        console.log(`[LIVE] 💥 Executing FAK: ${side} @ ${price.toFixed(2)} (Token: ${tokenId.substring(0, 8)}...)`);

        try {
            await this.ensureClobClient();

            const orderArgs = {
                tokenID: tokenId,
                amount: size, // For FAK, use amount instead of size
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                price: price,
                feeRateBps: 0,
            };

            // Use createAndPostMarketOrder for FAK execution
            await this.clobClient!.createAndPostMarketOrder(orderArgs);
            console.log(`[LIVE] ✅ FAK executed`);
            return true;

        } catch (error) {
            console.error(`[LIVE] ❌ Error executing FAK:`, error);
            return false;
        }
    }

    /**
     * Check if an order is filled (handles both PAPER and LIVE)
     */
    async isOrderFilled(orderId: string): Promise<boolean> {
        if (CONFIG.PAPER_TRADE) {
            return this.filledPaperOrders.has(orderId);
        } else {
            try {
                await this.ensureClobClient();
                const order = await this.clobClient!.getOrder(orderId);
                
                // Polymarket CLOB statuses are typically uppercase: 'OPEN', 'FILLED', 'CANCELED', 'EXPIRED'
                const status = (order.status || '').toUpperCase();
                return status === 'FILLED';
            } catch (error) {
                // In production, you might want to check trade history if getOrder fails
                // but for active monitoring, this is the standard approach
                return false;
            }
        }
    }

    /**
     * Get current paper position (for paper trading only)
     * Now returns the first position or null
     */
    getPaperPosition(): Position | null {
        if (this.paperPositions.size === 0) return null;
        const firstPos = this.paperPositions.values().next().value;
        return firstPos || null;
    }

    /**
     * Get all paper positions
     */
    getAllPaperPositions(): Position[] {
        return Array.from(this.paperPositions.values());
    }

    /**
     * Check if we have a paper position for a specific token
     */
    hasPaperPosition(tokenId: string): boolean {
        return this.paperPositions.has(tokenId);
    }

    /**
     * Get paper cash balance
     */
    getPaperCash(): number {
        return this.paperCash;
    }

    /**
     * Get active paper orders
     */
    getPaperOrders(): Order[] {
        return Array.from(this.paperOrders.values());
    }

    /**
     * Clear all orders and positions (for market rotation)
     * Handles both PAPER and LIVE trading modes
     */
    async clearAllState(): Promise<void> {
        if (CONFIG.PAPER_TRADE) {
            // Paper trading: just clear in-memory state
            console.log('[PAPER] 🧹 Clearing paper orders and positions for market rotation');
            const orderCount = this.paperOrders.size;
            const hadPosition = this.paperPositions.size > 0;
            
            this.paperOrders.clear();
            this.paperPositions.clear();
            this.filledPaperOrders.clear();
            this.isExecutingTrade = false;
            
            if (orderCount > 0) {
                console.log(`[PAPER] 🗑️ Cancelled ${orderCount} pending orders`);
            }
            if (hadPosition) {
                console.log(`[PAPER] ⚠️ Cleared positions (market rotated)`);
            }
        } else {
            // Live trading: cancel all open orders on exchange
            console.log('[LIVE] 🧹 Cancelling all open orders for market rotation');
            try {
                await this.ensureClobClient();
                
                // Get all open orders
                const openOrders = await this.clobClient!.getOpenOrders();
                
                if (openOrders && openOrders.length > 0) {
                    console.log(`[LIVE] Found ${openOrders.length} open orders to cancel`);
                    
                    // Extract IDs from OpenOrder objects
                    const orderIds = openOrders
                        .map((order: { id?: string }) => order.id)
                        .filter((id: string | undefined): id is string => !!id);
                    
                    for (const orderId of orderIds) {
                        try {
                            await this.cancelLiveOrder(orderId);
                        } catch (error) {
                            console.error(`[LIVE] ⚠️ Failed to cancel order ${orderId}:`, error);
                        }
                    }
                    console.log(`[LIVE] ✅ Attempted to cancel ${orderIds.length} orders`);
                } else {
                    console.log(`[LIVE] ℹ️ No open orders to cancel`);
                }
                
                this.isExecutingTrade = false;
            } catch (error) {
                console.error('[LIVE] ❌ Error clearing live orders:', error);
                // Don't throw - continue with market rotation even if cleanup fails
            }
        }
    }

    /**
     * Clear all paper orders and positions (for market rotation)
     * @deprecated Use clearAllState() instead - it handles both paper and live
     */
    async clearPaperState(): Promise<void> {
        if (CONFIG.PAPER_TRADE) {
            await this.clearAllState();
        } else {
            console.warn('[LIVE] clearPaperState() called in live mode - use clearAllState() instead');
        }
    }

    /**
     * Reset paper cash to initial amount (optional - for full reset)
     */
    resetPaperCash(initialAmount: number = 20.00): void {
        this.paperCash = initialAmount;
        console.log(`[PAPER] 💵 Reset cash to $${this.paperCash.toFixed(2)}`);
    }
}
