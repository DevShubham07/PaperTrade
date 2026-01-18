/**
 * Market Info Service
 * Fetches market details, strike prices, and manages market discovery
 */

import { SlugOracle, MarketConfig } from '../slugOracle';

export interface MarketInfo {
    eventSlug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    strikePrice: number;
    startDate: Date;
    endDate: Date;
    question: string;
}

export class MarketInfoService {
    private slugOracle: SlugOracle;
    private currentMarket: MarketConfig | null = null;

    constructor() {
        this.slugOracle = new SlugOracle();
        console.log('🎯 Market Info Service initialized');
    }

    /**
     * Get the currently active 15m BTC market
     */
    async getActiveMarket(): Promise<MarketInfo | null> {
        const market = await this.slugOracle.getActiveMarket();

        if (!market) {
            return null;
        }

        this.currentMarket = market;

        return {
            eventSlug: market.eventSlug,
            conditionId: market.conditionId,
            upTokenId: market.upTokenId,
            downTokenId: market.downTokenId,
            strikePrice: market.strikePrice,
            startDate: market.startDate,
            endDate: market.endDate,
            question: market.question
        };
    }

    /**
     * Get the current strike price (price to beat)
     * If market hasn't been loaded yet, returns 0
     */
    getStrikePrice(): number {
        return this.currentMarket?.strikePrice || 0;
    }

    /**
     * Get token IDs for UP and DOWN tokens
     */
    getTokenIds(): { upTokenId: string; downTokenId: string } | null {
        if (!this.currentMarket) {
            return null;
        }

        return {
            upTokenId: this.currentMarket.upTokenId,
            downTokenId: this.currentMarket.downTokenId
        };
    }

    /**
     * Get the price to beat for a specific market
     */
    async getPriceToBeat(
        slug: string,
        eventStartTime: string | Date,
        endDate: string | Date
    ): Promise<number> {
        return this.slugOracle.getPriceToBeat(slug, eventStartTime, endDate);
    }

    /**
     * Check if market is about to expire
     */
    isMarketExpiring(thresholdSeconds: number = 30): boolean {
        if (!this.currentMarket) {
            return false;
        }
        return this.slugOracle.isMarketExpiring(this.currentMarket.endDate, thresholdSeconds);
    }

    /**
     * Get time remaining until market expiry in minutes
     */
    getTimeRemaining(): number {
        if (!this.currentMarket) {
            return 0;
        }
        return this.slugOracle.getTimeRemaining(this.currentMarket.endDate);
    }

    /**
     * Check if current market is still valid
     */
    isMarketValid(): boolean {
        if (!this.currentMarket) {
            return false;
        }
        return this.slugOracle.isMarketValid(this.currentMarket);
    }

    /**
     * Clear current market (for rotation)
     */
    clearMarket(): void {
        this.currentMarket = null;
    }

    /**
     * Get current market info
     */
    getCurrentMarket(): MarketInfo | null {
        if (!this.currentMarket) {
            return null;
        }

        return {
            eventSlug: this.currentMarket.eventSlug,
            conditionId: this.currentMarket.conditionId,
            upTokenId: this.currentMarket.upTokenId,
            downTokenId: this.currentMarket.downTokenId,
            strikePrice: this.currentMarket.strikePrice,
            startDate: this.currentMarket.startDate,
            endDate: this.currentMarket.endDate,
            question: this.currentMarket.question
        };
    }
}
