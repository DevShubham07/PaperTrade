/**
 * Order Book Service
 * Fetches order book data and prices for UP/DOWN tokens from Polymarket
 */

import { ClobClient } from '@polymarket/clob-client';
import { CONFIG } from '../config';
import { createClobClient } from '../clobClientFactory';

export interface OrderBookData {
    tokenId: string;
    bestAsk: number;      // Price to BUY token
    bestBid: number;      // Price to SELL token
    spread: number;       // Ask - Bid
    askSize: number;      // Liquidity at buy price
    bidSize: number;      // Liquidity at sell price
}

export interface TokenPrices {
    upPrice: number;      // UP token buy price
    downPrice: number;    // DOWN token buy price
    upBid: number;        // UP token sell price
    downBid: number;      // DOWN token sell price
}

export class OrderBookService {
    private clobClient: ClobClient | null = null;

    constructor() {
        console.log('📖 Order Book Service initialized');
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
     * Fetch order book for a specific token
     */
    async getOrderBook(tokenId: string): Promise<OrderBookData> {
        try {
            await this.ensureClobClient();
            const book = await this.clobClient!.getOrderBook(tokenId);

            // Handle completely empty order book
            if ((!book.asks || book.asks.length === 0) && (!book.bids || book.bids.length === 0)) {
                throw new Error(`Order book is completely empty for token ${tokenId}`);
            }

            // Allow partial order books (either asks OR bids may be empty)
            const bestAsk = (book.asks && book.asks.length > 0)
                ? Math.min(...book.asks.map((ask: any) => parseFloat(ask.price)))
                : 0;
            const bestBid = (book.bids && book.bids.length > 0)
                ? Math.max(...book.bids.map((bid: any) => parseFloat(bid.price)))
                : 0;

            const askLevel = bestAsk > 0 && book.asks
                ? book.asks.find((ask: any) => parseFloat(ask.price) === bestAsk)
                : null;
            const bidLevel = bestBid > 0 && book.bids
                ? book.bids.find((bid: any) => parseFloat(bid.price) === bestBid)
                : null;

            const askSize = askLevel ? parseFloat(askLevel.size || '0') : 0;
            const bidSize = bidLevel ? parseFloat(bidLevel.size || '0') : 0;

            return {
                tokenId,
                bestAsk,
                bestBid,
                spread: bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid) : 0,
                askSize,
                bidSize
            };

        } catch (error) {
            console.error(`❌ Error fetching order book for ${tokenId}:`, error);
            throw error;
        }
    }

    /**
     * Fetch prices for both UP and DOWN tokens
     */
    async getTokenPrices(upTokenId: string, downTokenId: string): Promise<TokenPrices> {
        try {
            // Fetch both order books in parallel
            const [upBook, downBook] = await Promise.all([
                this.getOrderBook(upTokenId),
                this.getOrderBook(downTokenId)
            ]);

            return {
                upPrice: upBook.bestAsk,
                downPrice: downBook.bestAsk,
                upBid: upBook.bestBid,
                downBid: downBook.bestBid
            };

        } catch (error) {
            console.error('❌ Error fetching token prices:', error);
            throw error;
        }
    }

    /**
     * Get the current prices at each instance
     * Returns buy and sell prices for UP and DOWN tokens
     */
    async getCurrentPrices(upTokenId: string, downTokenId: string): Promise<{
        timestamp: Date;
        upAsk: number;      // UP buy price
        upBid: number;      // UP sell price
        downAsk: number;    // DOWN buy price
        downBid: number;    // DOWN sell price
    }> {
        const prices = await this.getTokenPrices(upTokenId, downTokenId);

        return {
            timestamp: new Date(),
            upAsk: prices.upPrice,
            upBid: prices.upBid,
            downAsk: prices.downPrice,
            downBid: prices.downBid
        };
    }

    /**
     * Check if spread is acceptable for a token
     */
    async isSpreadAcceptable(tokenId: string, maxSpread: number): Promise<boolean> {
        try {
            const orderBook = await this.getOrderBook(tokenId);
            return orderBook.spread <= maxSpread;
        } catch (error) {
            console.error(`❌ Error checking spread for ${tokenId}:`, error);
            return false;
        }
    }
}
