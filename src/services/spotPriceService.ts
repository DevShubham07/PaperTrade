/**
 * Spot Price Service
 * Fetches real-time Bitcoin spot price from Binance
 */

import { BinanceSocket } from '../binance';

export class SpotPriceService {
    private binanceSocket: BinanceSocket;

    constructor() {
        this.binanceSocket = new BinanceSocket();
        console.log('📊 Spot Price Service initialized');
    }

    /**
     * Get current Bitcoin spot price
     */
    getBTCPrice(): number {
        return this.binanceSocket.getBTCPrice();
    }

    /**
     * Check if the service is ready to provide prices
     */
    isReady(): boolean {
        return this.binanceSocket.isReady();
    }

    /**
     * Cleanup resources
     */
    disconnect(): void {
        this.binanceSocket.disconnect();
        console.log('📊 Spot Price Service disconnected');
    }
}
