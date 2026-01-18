/**
 * Quant Engine
 * Handles mathematical analysis, fair value calculations, and volatility tracking.
 * ⚠️ FIXED: Now uses Volatility of Returns (changes) instead of Volatility of Levels.
 */

export class QuantEngine {
    private priceHistory: { price: number; timestamp: number }[] = [];
    private readonly MAX_HISTORY_LENGTH = 60; // Keep last 60 ticks (approx 1 minute of data if 1s ticks)

    /**
     * Update price history for volatility calculation
     * Call this every time you get a new spot price
     */
    updatePrice(price: number): void {
        this.priceHistory.push({ price, timestamp: Date.now() });
        if (this.priceHistory.length > this.MAX_HISTORY_LENGTH) {
            this.priceHistory.shift();
        }
    }

    /**
     * CORRECTED Volatility Calculation
     * Calculates the standard deviation of price CHANGES (returns),
     * then scales it to a 1-minute timeframe using the Square Root of Time rule.
     */
    getVolatilityPerMinute(): number {
        if (this.priceHistory.length < 5) return 10.0; // Require minimum 5 price points for reliable volatility

        // 1. Calculate price changes (deltas) between ticks
        const changes: number[] = [];
        for (let i = 1; i < this.priceHistory.length; i++) {
            const delta = this.priceHistory[i].price - this.priceHistory[i - 1].price;
            changes.push(delta);
        }

        // 2. Calculate Standard Deviation of these changes (Volatility per Tick)
        const meanChange = changes.reduce((a, b) => a + b, 0) / changes.length;
        const variance = changes.reduce((a, b) => a + Math.pow(b - meanChange, 2), 0) / changes.length;
        const stdDevPerTick = Math.sqrt(variance);

        // 3. Annualize to 1 Minute using Square Root of Time rule
        // Volatility scales with the square root of time.
        // If we have 1-second ticks, 1-min vol = tick_vol * sqrt(60).

        // Calculate actual ticks per minute based on history
        const timeSpanSeconds = (this.priceHistory[this.priceHistory.length - 1].timestamp - this.priceHistory[0].timestamp) / 1000;
        const ticksPerMinute = timeSpanSeconds > 0 ? (this.priceHistory.length / timeSpanSeconds) * 60 : 60;

        // Final Volatility = SD_per_tick * sqrt(Ticks_per_minute)
        const volatilityPerMinute = stdDevPerTick * Math.sqrt(ticksPerMinute);

        // Floor at $5.00 to prevent overconfidence in flat markets
        return Math.max(5.0, volatilityPerMinute);
    }

    /**
     * Check if we have sufficient price history for reliable calculations
     */
    hasMinimumHistory(): boolean {
        return this.priceHistory.length >= 5;
    }

    /**
     * Get current price history length
     */
    getHistoryLength(): number {
        return this.priceHistory.length;
    }

    /**
     * Calculate Fair Value (Theoretical Probability)
     * Uses Z-Score: distance from strike / expected movement
     * 
     * @param spotPrice Current Bitcoin price
     * @param strikePrice Market strike price
     * @param timeRemainingSeconds Time left in seconds
     * @param volatility Volatility ($ movement per minute)
     * @param direction 'UP' or 'DOWN'
     */
    calculateFairValue(
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number,
        volatility: number,
        direction: 'UP' | 'DOWN'
    ): number {
        // Safety: If time is expired, return result immediately
        if (timeRemainingSeconds <= 0) {
            const win = direction === 'UP' ? spotPrice > strikePrice : spotPrice < strikePrice;
            return win ? 1.0 : 0.0;
        }

        // 1. Calculate Time Factor (Square root of time in minutes)
        const timeInMinutes = Math.max(0.01, timeRemainingSeconds / 60);
        const timeFactor = Math.sqrt(timeInMinutes);

        // 2. Calculate Distance
        let distance = direction === 'UP' 
            ? spotPrice - strikePrice 
            : strikePrice - spotPrice;

        // 3. Calculate Expected Move (Standard Deviation over remaining time)
        // This is the 1-SD range for the remaining duration
        const expectedMove = volatility * timeFactor;

        // 4. Calculate Z-Score (How many standard deviations are we away from losing?)
        const zScore = distance / expectedMove;

        // 5. Convert Z-Score to Probability
        return this.normalCDF(zScore);
    }

    /**
     * Approximation of the Cumulative Distribution Function (CDF) for Standard Normal Distribution
     * Converts a Z-Score into a Probability (0.0 to 1.0)
     * Algorithm: Abramowitz & Stegun 26.2.17
     */
    private normalCDF(z: number): number {
        // Constants for approximation
        const p = 0.2316419;
        const b1 = 0.319381530;
        const b2 = -0.356563782;
        const b3 = 1.781477937;
        const b4 = -1.821255978;
        const b5 = 1.330274429;

        const t = 1 / (1 + p * Math.abs(z));
        const t_poly = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-z * z / 2) *
            (b1 * t + b2 * Math.pow(t, 2) + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));

        // Algorithm logic:
        // If z >= 0, probability is > 0.5 (t_poly is the result)
        // If z < 0, probability is < 0.5 (1 - t_poly)
        if (z >= 0) {
            return t_poly;
        } else {
            return 1 - t_poly;
        }
    }
}
