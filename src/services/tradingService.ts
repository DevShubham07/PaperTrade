/**
 * Trading Service
 * Handles BUY/SELL execution, order management, and position tracking
 * Supports both PAPER and LIVE trading modes
 */

import { Side } from '@polymarket/clob-client';
import { CONFIG } from '../config';
import { createClobClient } from '../clobClientFactory';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

export interface Order {
    id: string;
    tokenId: string;
    side: OrderSide;
    price: number;
    size: number;
    timestamp: number;
}

export interface Position {
    tokenId: string;
    shares: number;
    entryPrice: number;
    entryTime: number;
}

export interface TradeResult {
    success: boolean;
    orderId?: string;
    position?: Position;
    error?: string;
}

export class TradingService {
    private clobClient: Awaited<ReturnType<typeof createClobClient>> | null = null;

    // Paper Trading State
    private paperCash: number = 100.00;
    private paperPosition: Position | null = null;
    private paperOrders: Map<string, Order> = new Map();
    private paperOrderCounter: number = 0;

    constructor() {
        console.log('⚡ Trading Service initialized');
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

    // ==========================================
    // PUBLIC API - CORE TRADING METHODS
    // ==========================================

    /**
     * BUY tokens at specified price
     * @param tokenId - Token ID to buy
     * @param price - Limit price
     * @param size - Number of shares
     * @returns Order ID
     */
    async buy(tokenId: string, price: number, size: number): Promise<string> {
        return this.placeLimitOrder(tokenId, 'BUY', price, size);
    }

    /**
     * SELL tokens at specified price
     * @param tokenId - Token ID to sell
     * @param price - Limit price
     * @param size - Number of shares
     * @returns Order ID
     */
    async sell(tokenId: string, price: number, size: number): Promise<string> {
        return this.placeLimitOrder(tokenId, 'SELL', price, size);
    }

    /**
     * Place a limit order (BUY or SELL)
     * @param tokenId - Token ID
     * @param side - 'BUY' or 'SELL'
     * @param price - Limit price
     * @param size - Number of shares
     * @returns Order ID
     */
    async placeLimitOrder(tokenId: string, side: OrderSide, price: number, size: number): Promise<string> {
        if (CONFIG.PAPER_TRADE) {
            return this.placePaperOrder(tokenId, side, price, size, 'GTC');
        } else {
            return this.placeLiveOrder(tokenId, side, price, size, 'GTC');
        }
    }

    /**
     * Cancel an active order
     * @param orderId - Order ID to cancel
     * @returns Success status
     */
    async cancelOrder(orderId: string): Promise<boolean> {
        if (CONFIG.PAPER_TRADE) {
            return this.cancelPaperOrder(orderId);
        } else {
            return this.cancelLiveOrder(orderId);
        }
    }

    /**
     * Execute immediate market order (Fill-And-Kill)
     * @param tokenId - Token ID
     * @param side - 'BUY' or 'SELL'
     * @param price - Price limit
     * @param size - Number of shares
     * @returns Success status
     */
    async executeMarketOrder(tokenId: string, side: OrderSide, price: number, size: number): Promise<boolean> {
        if (CONFIG.PAPER_TRADE) {
            return this.executePaperFAK(tokenId, side, price, size);
        } else {
            return this.executeLiveFAK(tokenId, side, price, size);
        }
    }

    // ==========================================
    // POSITION & BALANCE QUERIES
    // ==========================================

    /**
     * Get current position (paper trading only)
     */
    getCurrentPosition(): Position | null {
        return this.paperPosition;
    }

    /**
     * Get available cash balance (paper trading only)
     */
    getCashBalance(): number {
        return this.paperCash;
    }

    /**
     * Get all active orders (paper trading only)
     */
    getActiveOrders(): Order[] {
        return Array.from(this.paperOrders.values());
    }

    /**
     * Check if we have an open position
     */
    hasPosition(): boolean {
        return this.paperPosition !== null;
    }

    /**
     * Get position for specific token
     */
    getPositionForToken(tokenId: string): Position | null {
        if (this.paperPosition && this.paperPosition.tokenId === tokenId) {
            return this.paperPosition;
        }
        return null;
    }

    // ==========================================
    // PAPER TRADING SIMULATION
    // ==========================================

    /**
     * Check if paper orders should fill based on current market prices
     * Call this every tick with current market data
     */
    checkPaperFills(tokenId: string, currentBestAsk: number, currentBestBid: number): Position | null {
        for (const [orderId, order] of this.paperOrders.entries()) {
            // Only check orders for the correct token
            if (order.tokenId !== tokenId) continue;

            let filled = false;

            if (order.side === 'BUY' && currentBestAsk <= order.price) {
                // Buy order filled - market came down to our price
                filled = true;
                const cost = order.price * order.size;
                this.paperCash -= cost;
                this.paperPosition = {
                    tokenId: order.tokenId,
                    shares: order.size,
                    entryPrice: order.price,
                    entryTime: Date.now()
                };
                console.log(`[PAPER] 🔔 BUY ORDER FILLED @ ${order.price.toFixed(4)}. Cash: $${this.paperCash.toFixed(2)}`);
            } else if (order.side === 'SELL' && currentBestBid >= order.price) {
                // Sell order filled - market came up to our price
                filled = true;
                const proceeds = order.price * order.size;
                this.paperCash += proceeds;
                if (this.paperPosition) {
                    const pnl = (order.price - this.paperPosition.entryPrice) * order.size;
                    console.log(`[PAPER] 🔔 SELL ORDER FILLED @ ${order.price.toFixed(4)}. P&L: $${pnl.toFixed(2)}. Cash: $${this.paperCash.toFixed(2)}`);
                }
                this.paperPosition = null;
            }

            if (filled) {
                this.paperOrders.delete(orderId);
                return this.paperPosition;
            }
        }

        return null;
    }

    // ==========================================
    // PRIVATE - PAPER TRADING METHODS
    // ==========================================

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
        console.log(`[PAPER] 📝 ${side} LIMIT @ ${price.toFixed(4)} | Token: ${tokenId.substring(0, 8)}... | Size: ${size}`);

        return orderId;
    }

    private cancelPaperOrder(orderId: string): boolean {
        if (this.paperOrders.has(orderId)) {
            this.paperOrders.delete(orderId);
            console.log(`[PAPER] 🗑️ Cancelled Order ${orderId}`);
            return true;
        }
        console.warn(`[PAPER] ⚠️ Order ${orderId} not found`);
        return false;
    }

    private executePaperFAK(tokenId: string, side: OrderSide, price: number, size: number): boolean {
        console.log(`[PAPER] 💥 MARKET ORDER: ${side} @ ${price.toFixed(4)} | Token: ${tokenId.substring(0, 8)}... | Size: ${size}`);

        if (side === 'BUY') {
            const cost = price * size;
            if (this.paperCash >= cost) {
                this.paperCash -= cost;
                this.paperPosition = {
                    tokenId,
                    shares: size,
                    entryPrice: price,
                    entryTime: Date.now()
                };
                console.log(`[PAPER] ✅ BOUGHT ${size} shares @ ${price.toFixed(4)}. Cash: $${this.paperCash.toFixed(2)}`);
                return true;
            } else {
                console.error(`[PAPER] ❌ Insufficient cash. Need $${cost.toFixed(2)}, have $${this.paperCash.toFixed(2)}`);
                return false;
            }
        } else {
            // SELL
            if (this.paperPosition && this.paperPosition.shares >= size && this.paperPosition.tokenId === tokenId) {
                const proceeds = price * size;
                this.paperCash += proceeds;
                const pnl = (price - this.paperPosition.entryPrice) * size;
                console.log(`[PAPER] ✅ SOLD ${size} shares @ ${price.toFixed(4)}. P&L: $${pnl.toFixed(2)}. Cash: $${this.paperCash.toFixed(2)}`);
                this.paperPosition = null;
                return true;
            } else {
                console.error(`[PAPER] ❌ No position to sell or wrong token`);
                return false;
            }
        }
    }

    // ==========================================
    // PRIVATE - LIVE TRADING METHODS
    // ==========================================

    private async placeLiveOrder(tokenId: string, side: OrderSide, price: number, size: number, type: OrderType): Promise<string> {
        console.log(`[LIVE] 💸 ${side} LIMIT @ ${price.toFixed(4)} | Token: ${tokenId.substring(0, 8)}...`);

        try {
            const orderArgs = {
                tokenID: tokenId,
                price: price,
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                size: size,
                feeRateBps: 0,
            };

            await this.ensureClobClient();
            const response = await this.clobClient!.createAndPostOrder(orderArgs);
            console.log(`[LIVE] ✅ Order placed. ID: ${response.orderID}`);
            return response.orderID;

        } catch (error) {
            console.error(`[LIVE] ❌ Error placing order:`, error);
            throw error;
        }
    }

    private async cancelLiveOrder(orderId: string): Promise<boolean> {
        console.log(`[LIVE] 📡 Cancelling order ${orderId}`);

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

    private async executeLiveFAK(tokenId: string, side: OrderSide, price: number, size: number): Promise<boolean> {
        console.log(`[LIVE] 💥 MARKET ORDER: ${side} @ ${price.toFixed(4)} | Token: ${tokenId.substring(0, 8)}...`);

        try {
            const orderArgs = {
                tokenID: tokenId,
                price: price,
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                size: size,
                feeRateBps: 0,
            };

            await this.ensureClobClient();
            await this.clobClient!.createAndPostMarketOrder({
                tokenID: tokenId,
                amount: size,
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                price: price,
                feeRateBps: 0,
            });
            console.log(`[LIVE] ✅ Market order executed`);
            return true;

        } catch (error) {
            console.error(`[LIVE] ❌ Error executing market order:`, error);
            return false;
        }
    }

    // ==========================================
    // UTILITY METHODS
    // ==========================================

    /**
     * Calculate P&L for a position
     */
    calculatePnL(entryPrice: number, exitPrice: number, shares: number): number {
        return (exitPrice - entryPrice) * shares;
    }

    /**
     * Check if order exists in paper trading
     */
    hasOrder(orderId: string): boolean {
        return this.paperOrders.has(orderId);
    }

    /**
     * Get paper cash (for display/logging)
     */
    getPaperCash(): number {
        return this.paperCash;
    }
}
