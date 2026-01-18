/**
 * Slug Oracle Module
 * Automatically finds current 15m BTC Gamma markets and handles rotation
 */

import axios from 'axios';
import { CONFIG } from './config';

// CONSTANTS
const GAMMA_API = 'https://gamma-api.polymarket.com';

export interface MarketConfig {
    eventSlug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    strikePrice: number;
    startDate: Date;
    endDate: Date;
    question: string;
    nextMarket?: {
        slug: string;
        startDate: Date;
    };
}

export class SlugOracle {
    private strikePriceCache: Map<string, number> = new Map();

    /**
     * Finds the Currently Active 15m BTC Market
     * Returns: The Market Object (Condition ID, Token IDs, Strike Price)
     */
    async getActiveMarket(): Promise<MarketConfig | null> {
        try {
            // 1. CALCULATE CURRENT MARKET SLUG
            // 15m BTC markets run continuously on 15-minute boundaries
            // The slug format is: btc-updown-15m-{end_timestamp}
            const now = Date.now();
            const nowSec = Math.floor(now / 1000);
            const interval = 15 * 60; // 15 minutes in seconds

            // Calculate the current 15-minute boundary (market end time)
            const currentBoundary = Math.floor(nowSec / interval) * interval;
            const nextBoundary = currentBoundary + interval;
            const prevBoundary = currentBoundary - interval;

            // Find the currently ACTIVE market
            // A market is active if: eventStartTime <= now < endDate
            // The slug timestamp is the END time of the market

            // Try multiple potential market windows
            const slugsToTry = [
                { timestamp: nextBoundary, label: 'next 15m' },
                { timestamp: currentBoundary, label: 'current 15m' },
                { timestamp: prevBoundary, label: 'previous 15m' },
                { timestamp: prevBoundary - interval, label: 'two windows ago' }
            ];

            // Fetch all potential markets in parallel for speed
            const marketPromises = slugsToTry.map(async ({ timestamp }) => {
                const slug = `btc-updown-15m-${timestamp}`;
                try {
                    const response = await axios.get(`${GAMMA_API}/markets`, {
                        params: { slug },
                        timeout: 500 // 0.5 second timeout for fast market switching
                    });
                    if (response.data && response.data.length > 0) {
                        return { slug, market: response.data[0] };
                    }
                } catch (error: any) {
                    // Market doesn't exist for this timestamp
                }
                return null;
            });

            const marketResults = await Promise.all(marketPromises);
            
            let marketData = null;
            let activeSlug = null;

            // Find the first active market from parallel results
            for (const result of marketResults) {
                if (!result) continue;
                
                const { slug, market } = result;
                const eventStartTime = new Date(market.eventStartTime || market.startDate).getTime();
                const endDate = new Date(market.endDate).getTime();
                const hasStarted = eventStartTime <= now;
                const hasntEnded = now < endDate;
                const isAccepting = market.active && market.acceptingOrders && !market.closed;

                if (hasStarted && hasntEnded && isAccepting) {
                    marketData = market;
                    activeSlug = slug;
                    break;
                }
            }

            if (!marketData || !activeSlug) {
                return null;
            }

            // 2. EXTRACT MARKET DATA

            // Get token IDs from clobTokenIds
            // First token is UP, second token is DOWN (matches outcomes array order)
            let upTokenId = '';
            let downTokenId = '';

            if (marketData.clobTokenIds) {
                const tokenIds = JSON.parse(marketData.clobTokenIds);
                upTokenId = tokenIds[0];      // UP token
                downTokenId = tokenIds[1];    // DOWN token
            }

            // Validate we have token IDs
            if (!upTokenId || !downTokenId) {
                console.error('❌ Could not extract token IDs from market');
                console.error(`   upTokenId: ${upTokenId}`);
                console.error(`   downTokenId: ${downTokenId}`);
                return null;
            }

            // Extract Starting Price for Up/Down markets (Price to Beat)
            // These markets resolve based on: end_price >= start_price = UP, otherwise DOWN
            // The "strike" is effectively the starting price of the 15-minute window
            // NOTE: In hedge arbitrage mode, we do NOT block market discovery on strike-price API.
            let startingPrice = 0;

            if (CONFIG.HEDGE_ARBITRAGE_MODE) {
                // Hedge arbitrage only needs the strike at settlement time.
                // We avoid blocking market discovery here to prevent rate-limit stalls.
                startingPrice = 0;
            } else {
                // Fetch from Polymarket crypto-price API (authoritative source)
                // Extract dates - handle both string and Date formats
                let eventStart: string | Date | undefined = marketData.eventStartTime || marketData.startDate;
                let eventEnd: string | Date | undefined = marketData.endDate;
                
                // Convert strings to Date objects if needed
                if (eventStart && typeof eventStart === 'string') {
                    eventStart = new Date(eventStart);
                }
                if (eventEnd && typeof eventEnd === 'string') {
                    eventEnd = new Date(eventEnd);
                }
                
                // Check cache first for instant response
                if (this.strikePriceCache.has(activeSlug)) {
                    startingPrice = this.strikePriceCache.get(activeSlug) as number;
                    console.log(`💰 Strike price from cache: $${startingPrice.toFixed(2)}`);
                } else if (eventStart && eventEnd) {
                    // Fetch price synchronously (await it)
                    try {
                        console.log(`🔍 Fetching strike price for ${activeSlug}...`);
                        const fetchedPrice = await this.getPriceToBeatWithRetry(activeSlug, eventStart, eventEnd);
                        if (fetchedPrice > 0) {
                            startingPrice = fetchedPrice;
                            this.strikePriceCache.set(activeSlug, fetchedPrice);
                            console.log(`✅ Strike price fetched: $${startingPrice.toFixed(2)}`);
                        } else {
                            console.warn(`⚠️ Strike price fetch returned 0 for ${activeSlug}`);
                        }
                    } catch (error: any) {
                        console.error(`❌ Failed to fetch strike price: ${error.message}`);
                        // Will try fallback
                    }
                }
            }

            // Fallback to metadata only if API failed
            if (startingPrice === 0) {
                if (marketData.startingPrice) {
                    startingPrice = parseFloat(marketData.startingPrice);
                } else if (marketData.metadata?.startingPrice) {
                    startingPrice = parseFloat(marketData.metadata.startingPrice);
                }
            }

            const config: MarketConfig = {
                eventSlug: activeSlug,
                conditionId: marketData.conditionId,
                upTokenId: upTokenId,
                downTokenId: downTokenId,
                strikePrice: startingPrice,
                startDate: new Date(marketData.startDate),
                endDate: new Date(marketData.endDate),
                question: marketData.question
            };

            // Calculate next market dynamically (no API call needed)
            const nextSlug = `btc-updown-15m-${nextBoundary}`;
            config.nextMarket = {
                slug: nextSlug,
                startDate: new Date(nextBoundary * 1000) // Next market starts when current ends
            };

            return config;

        } catch (error: any) {
            console.error('🔥 SlugOracle Failed:', error.message);
            if (error.response) {
                console.error('API Response:', error.response.status, error.response.statusText);
            }
            return null;
        }
    }

    /**
     * Gets the "Price to Beat" (openPrice) for a given slug
     * This is the Bitcoin price at the start of the 15-minute window
     * @param slug - Market slug (e.g., "btc-updown-15m-1765548900")
     * @param eventStartTime - Event start time (ISO string or Date)
     * @param endDate - Event end time (ISO string or Date)
     * @returns The price to beat (openPrice) or 0 if not available
     */
    async getPriceToBeat(slug: string, eventStartTime: string | Date, endDate: string | Date): Promise<number> {
        // Convert dates to ISO strings if needed
        let startTime: string;
        let endTime: string;

        if (eventStartTime instanceof Date) {
            startTime = eventStartTime.toISOString();
        } else if (typeof eventStartTime === 'string') {
            // If it's already an ISO string, use it; otherwise try to parse
            startTime = eventStartTime.includes('T') ? eventStartTime : new Date(eventStartTime).toISOString();
        } else {
            throw new Error('Invalid eventStartTime format');
        }

        if (endDate instanceof Date) {
            endTime = endDate.toISOString();
        } else if (typeof endDate === 'string') {
            endTime = endDate.includes('T') ? endDate : new Date(endDate).toISOString();
        } else {
            throw new Error('Invalid endDate format');
        }

        // Call Polymarket's crypto-price API
        // Format: /api/crypto/crypto-price?symbol=BTC&eventStartTime={ISO}&variant=fifteen&endDate={ISO}
        const url = 'https://polymarket.com/api/crypto/crypto-price';
        const params = {
            symbol: 'BTC',
            eventStartTime: startTime,
            variant: 'fifteen',
            endDate: endTime
        };

        try {
            const response = await axios.get(url, { 
                params,
                timeout: 5000, // Increased timeout to 5 seconds
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            console.log('🔍 Strike price API response:', {
                status: response.status,
                data: response.data,
                url: url,
                params: params
            });

            if (response.data && response.data.openPrice) {
                const price = parseFloat(response.data.openPrice);
                return price;
            }

            console.warn('⚠️ API response missing openPrice:', response.data);
            return 0;
        } catch (error: any) {
            console.error('❌ Strike price API error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                url: url,
                params: params
            });

            // If it's a rate limit error, add extra logging and longer backoff
            if (error.response?.status === 429 || error.response?.data?.error?.includes('429')) {
                console.warn('🚦 Chainlink API rate limited (429) - this is normal during high traffic periods');
                console.warn('💡 Using longer backoff delays to respect rate limits');
                console.warn('💡 Consider using cached strike prices or manual strike price override');
                // Throw a special error to trigger longer backoff in retry logic
                throw new Error('RATE_LIMIT_429');
            }

            return 0;
        }
    }

    /**
     * Retry wrapper around getPriceToBeat to mitigate transient API issues
     * 🔧 FIX: Retries indefinitely until success (no more giving up!)
     */
    private async getPriceToBeatWithRetry(
        slug: string,
        eventStartTime: string | Date,
        endDate: string | Date,
        maxAttempts: number = Infinity, // ♾️ Never give up!
        baseDelayMs: number = 3000  // 3 seconds base delay
    ): Promise<number> {
        let attempt = 1;
        
        let isRateLimited = false;
        
        while (true) {
            try {
                const price = await this.getPriceToBeat(slug, eventStartTime, endDate);
                if (price > 0) {
                    if (attempt > 1) {
                        console.log(`✅ Strike price fetched successfully after ${attempt} attempts!`);
                    }
                    return price;
                }
            } catch (error: any) {
                // Check if it's a rate limit error
                if (error.message === 'RATE_LIMIT_429') {
                    isRateLimited = true;
                }
            }

            // Exponential backoff with longer delays for rate limits
            // For 429 errors, use longer base delay (10 seconds) and cap at 60 seconds
            const rateLimitBaseDelay = 10000; // 10 seconds for rate limits
            const normalBaseDelay = baseDelayMs;
            const baseDelay = isRateLimited ? rateLimitBaseDelay : normalBaseDelay;
            const maxDelay = isRateLimited ? 60000 : 30000; // 60s for rate limits, 30s otherwise
            const delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), maxDelay);
            
            console.log(`⏳ Strike price fetch failed. Retrying in ${(delay/1000).toFixed(1)}s (attempt ${attempt})...`);
            if (isRateLimited) {
                console.log('🚦 Rate limit detected - using longer backoff delays');
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            
            attempt++;
        }
    }

    /**
     * Helper: Extracts "$95,000" from "Will Bitcoin be above $95,000?"
     * Handles various formats: $95000, $95,000, $95,000.00
     */
    private parseStrikePrice(question: string): number {
        // Match dollar amounts with optional commas and decimals
        const match = question.match(/\$([\d,]+\.?\d*)/);

        if (match) {
            // Remove commas and convert to number
            const priceStr = match[1].replace(/,/g, '');
            return parseFloat(priceStr);
        }

        return 0;
    }

    /**
     * Checks if market is about to expire (within threshold)
     * @param endDate - Market expiry date
     * @param thresholdSeconds - How many seconds before expiry (default 30)
     */
    isMarketExpiring(endDate: Date, thresholdSeconds: number = 30): boolean {
        const now = new Date();
        const timeToClose = endDate.getTime() - now.getTime();
        return timeToClose < thresholdSeconds * 1000;
    }

    /**
     * Gets time remaining until market expiry in minutes
     */
    getTimeRemaining(endDate: Date): number {
        const now = new Date();
        const diffMs = endDate.getTime() - now.getTime();

        if (diffMs <= 0) {
            return 0;
        }

        return diffMs / 1000 / 60; // Returns minutes
    }

    /**
     * Validates that a market config is still valid
     */
    isMarketValid(config: MarketConfig): boolean {
        const now = new Date();
        return now < config.endDate;
    }
}
