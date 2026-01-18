/**
 * Data Logger Module
 * Stores tick data for 15-minute markets in JSON format
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TickData {
    timestamp: string;
    spotPrice: number;
    strikePrice: number;
    difference: number;
    currentUpPrice: number;
    currentDownPrice: number;
}

export class DataLogger {
    private dataDir: string;
    private currentMarketSlug: string | null = null;
    private currentFilePath: string | null = null;

    constructor(baseDir: string = './data') {
        this.dataDir = baseDir;
        this.ensureDataDirectory();
    }

    /**
     * Ensures the base data directory exists
     */
    private ensureDataDirectory(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Sets the current market and creates a new file for it
     */
    public setMarket(marketSlug: string): void {
        this.currentMarketSlug = marketSlug;
        const fileName = `${marketSlug}.json`;
        this.currentFilePath = path.join(this.dataDir, fileName);

        // Create empty array if file doesn't exist
        if (!fs.existsSync(this.currentFilePath)) {
            fs.writeFileSync(this.currentFilePath, '[]', 'utf-8');
        }
    }

    /**
     * Logs a tick of data to the current market file
     */
    public logTick(tickData: TickData): void {
        if (!this.currentFilePath || !this.currentMarketSlug) {
            console.warn('⚠️ No market set for data logging. Skipping tick.');
            return;
        }

        try {
            // Read existing data
            const fileContent = fs.readFileSync(this.currentFilePath, 'utf-8');
            const ticks: TickData[] = JSON.parse(fileContent);

            // Append new tick
            ticks.push(tickData);

            // Write back to file
            fs.writeFileSync(this.currentFilePath, JSON.stringify(ticks, null, 2), 'utf-8');
        } catch (error) {
            console.error('❌ Error logging tick data:', error);
        }
    }

    /**
     * Gets the current market slug
     */
    public getCurrentMarket(): string | null {
        return this.currentMarketSlug;
    }
}
