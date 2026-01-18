/**
 * Data Oracle Module
 * Fetches Truth: Polymarket OrderBook (Dynamic Token) & Bitcoin Spot Price
 */

import { ClobClient } from '@polymarket/clob-client';
import { BinanceSocket } from './binance';
import { CONFIG } from './config';
import { createClobClient } from './clobClientFactory';

export interface MarketState {
    bestAsk: number;      // Cheapest Seller
    bestBid: number;      // Highest Buyer
    spread: number;       // Ask - Bid
    askSize: number;      // Liquidity at best ask
    bidSize: number;      // Liquidity at best bid
}

export class DataOracle {
    private clobClient: ClobClient | null = null;
    private binanceSocket: BinanceSocket;

    constructor() {
        // Initialize Binance WebSocket
        this.binanceSocket = new BinanceSocket();

        console.log('🔮 Data Oracle initialized');
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
     * Fetches the Order Book (Liquidity) from Polymarket
     * ⚠️ CRITICAL FIX: Now accepts dynamic tokenId parameter
     *
     * @param tokenId - The specific token ID to fetch (UP or DOWN)
     */
    async getMarketState(tokenId: string): Promise<MarketState> {
        try {
            await this.ensureClobClient();
            // Fetch order book for the specific token
            const book = await this.clobClient!.getOrderBook(tokenId);

            // Handle empty order book
            if (!book.asks || book.asks.length === 0 || !book.bids || book.bids.length === 0) {
                throw new Error('Order book is empty or malformed');
            }

            const bestAsk = parseFloat(book.asks[0].price);
            const bestBid = parseFloat(book.bids[0].price);

            return {
                bestAsk,
                bestBid,
                spread: bestAsk - bestBid,
                askSize: parseFloat(book.asks[0].size || '0'),
                bidSize: parseFloat(book.bids[0].size || '0')
            };

        } catch (error) {
            console.error('❌ Error fetching market state:', error);
            throw error;
        }
    }

    /**
     * Fetches Real-World Bitcoin Price (The Truth)
     */
    getRealWorldPrice(): number {
        try {
            return this.binanceSocket.getBTCPrice();
        } catch (error) {
            console.error('❌ Error fetching BTC price:', error);
            throw error;
        }
    }

    /**
     * Checks if the data sources are ready
     */
    isReady(): boolean {
        return this.binanceSocket.isReady();
    }

    /**
     * Gets Time Remaining in Minutes until market expiry
     */
    getTimeRemaining(): number {
        const now = Date.now();
        const expiry = CONFIG.MARKET_EXPIRY_TIMESTAMP;
        const diffMs = expiry - now;

        if (diffMs <= 0) {
            return 0; // Market expired
        }

        return diffMs / 1000 / 60; // Returns minutes (e.g., 12.5)
    }

    /**
     * Checks if market has expired
     */
    hasMarketExpired(): boolean {
        return this.getTimeRemaining() <= 0;
    }

    /**
     * Cleanup resources
     */
    disconnect(): void {
        this.binanceSocket.disconnect();
        console.log('🔌 Data Oracle disconnected');
    }
}
