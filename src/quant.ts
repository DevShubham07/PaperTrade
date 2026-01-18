/**
 * Quant Engine Module
 * The Brain: Calculates "Fair Value" and determines Direction & Token Selection
 */

import { CONFIG } from './config';

export interface MarketAnalysis {
    direction: 'UP' | 'DOWN' | 'FLAT';
    targetTokenId: string;
    fairValue: number;
    probUp: number; // Raw probability that BTC will be UP
}

export class QuantEngine {

    /**
     * 🧠 CORE DIRECTIONAL ANALYSIS
     * Determines which token to trade (UP or DOWN) based on market direction
     *
     * @param spotPrice - Current Bitcoin spot price
     * @param strikePrice - The strike price to beat
     * @param minutesLeft - Minutes until market expiry
     * @returns Market analysis with direction, target token, and fair value
     */
    analyzeMarket(spotPrice: number, strikePrice: number, minutesLeft: number): MarketAnalysis {

        // 1. Calculate distance from strike
        const distance = spotPrice - strikePrice;

        // 2. "The Gamma Compressor"
        // At 15 mins left, we divide distance by 300 (Low sensitivity)
        // At 1 min left, we divide distance by 20 (High sensitivity)
        const sensitivity = Math.max(20, minutesLeft * 20);

        // 3. Calculate RAW "UP" probability
        // This represents the probability that BTC will be >= strike at expiry
        const shift = distance / sensitivity;
        let probUp = 0.50 + shift;

        // Clamp to prevent invalid probabilities
        probUp = Math.min(0.99, Math.max(0.01, probUp));

        // 4. ⚠️ DIRECTION SELECTOR (The Core Fix)
        let direction: 'UP' | 'DOWN' | 'FLAT';
        let targetTokenId: string;
        let fairValue: number;

        if (distance >= 0) {
            // BTC is currently ABOVE strike -> Favor UP
            direction = 'UP';
            targetTokenId = CONFIG.TOKEN_ID_UP;
            fairValue = probUp;
        } else {
            // BTC is currently BELOW strike -> Favor DOWN
            direction = 'DOWN';
            targetTokenId = CONFIG.TOKEN_ID_DOWN;
            // ⚠️ INVERT PROBABILITY: If Prob(UP) = 0.10, then Prob(DOWN) = 0.90
            fairValue = 1.00 - probUp;
        }

        return {
            direction,
            targetTokenId,
            fairValue,
            probUp
        };
    }

    /**
     * Calculates the "Vulture Price" (Entry Target)
     * We want to buy ONLY if we get a discount below fair value
     *
     * @param fairPrice - The calculated fair value
     * @returns Entry target price
     */
    getEntryTarget(fairPrice: number): number {
        const target = fairPrice - CONFIG.PANIC_DISCOUNT;
        // Round down to 2 decimals for precision
        return Math.max(0.01, Math.floor(target * 100) / 100);
    }

    /**
     * Calculates the Take Profit target price
     *
     * @param entryPrice - The price we entered at
     * @returns Take profit price
     */
    getTakeProfitTarget(entryPrice: number): number {
        const target = entryPrice + CONFIG.SCALP_PROFIT;
        // Round up to 2 decimals
        return Math.min(0.99, Math.ceil(target * 100) / 100);
    }

    /**
     * Calculates the Stop Loss trigger price
     *
     * @param entryPrice - The price we entered at
     * @returns Stop loss price
     */
    getStopLossPrice(entryPrice: number): number {
        const target = entryPrice - CONFIG.STOP_LOSS_THRESHOLD;
        return Math.max(0.01, target);
    }

    /**
     * Determines if the spread is acceptable for trading
     *
     * @param spread - Current market spread
     * @returns true if spread is reasonable
     */
    isSpreadAcceptable(spread: number): boolean {
        // Use configurable max spread (default 0.50 for illiquid markets)
        return spread <= CONFIG.MAX_SPREAD;
    }

    /**
     * Calculates position size based on available capital and price
     *
     * @param price - Entry price
     * @returns Number of shares to buy
     */
    calculatePositionSize(price: number): number {
        if (price <= 0) {
            throw new Error('Invalid price for position sizing');
        }

        // Calculate max shares we can afford
        const maxShares = Math.floor(CONFIG.MAX_CAPITAL_PER_TRADE / price);

        // Ensure minimum of 1 share
        return Math.max(1, maxShares);
    }

    /**
     * Determines if we should update our existing order
     *
     * @param currentOrderPrice - Price of our current order
     * @param newTargetPrice - New calculated target price
     * @returns true if order should be updated
     */
    shouldUpdateOrder(currentOrderPrice: number, newTargetPrice: number): boolean {
        const priceDeviation = Math.abs(currentOrderPrice - newTargetPrice);
        // Update if price moved more than 2 cents
        return priceDeviation > 0.02;
    }

    /**
     * Formats price for display (2 decimal places)
     */
    formatPrice(price: number): string {
        return price.toFixed(2);
    }

    /**
     * Formats USD amount for display
     */
    formatUSD(amount: number): string {
        return `$${amount.toFixed(2)}`;
    }

    /**
     * Calculates profit/loss for a position
     *
     * @param entryPrice - Entry price
     * @param exitPrice - Exit price
     * @param shares - Number of shares
     * @returns P&L in USD
     */
    calculatePnL(entryPrice: number, exitPrice: number, shares: number): number {
        return (exitPrice - entryPrice) * shares;
    }
}
