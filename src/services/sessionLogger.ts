/**
 * Session Logger Service
 * Lightweight, non-blocking logger that buffers data in memory
 * and flushes to JSON file at session end
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

export interface SessionTickData {
    tickNumber: number;
    timestamp: string;
    timestampMs: number;
    market: {
        slug: string;
        strikePrice: number;
        upTokenId: string;
        downTokenId: string;
        endDate: string;
    };
    spotPrice: number;
    difference: number;
    prices: {
        upAsk: number;
        upBid: number;
        downAsk: number;
        downBid: number;
    };
    timeRemaining: number;
}

export interface SessionData {
    sessionId: string;
    startTime: string;
    endTime: string;
    duration: number;
    marketSlug: string;
    totalTicks: number;
    ticks: SessionTickData[];
}

export class SessionLogger {
    private dataDir: string = './data';
    private sessionStartTime: number = 0;
    private currentMarketSlug: string = '';
    private ticks: SessionTickData[] = [];
    private isActive: boolean = false;

    constructor(dataDir: string = './data') {
        this.dataDir = dataDir;
        this.ensureDataDirectory();
    }

    /**
     * Ensure data directory exists (non-blocking)
     */
    private ensureDataDirectory(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Start a new session
     */
    public startSession(marketSlug: string): void {
        this.sessionStartTime = Date.now();
        this.currentMarketSlug = marketSlug;
        this.ticks = [];
        this.isActive = true;
    }

    /**
     * Log a tick (buffers in memory - fast, non-blocking)
     */
    public logTick(data: SessionTickData): void {
        if (!this.isActive) {
            return;
        }
        // Push to array - O(1) operation, no I/O
        this.ticks.push(data);
    }

    /**
     * End session and flush to JSON file (async, non-blocking)
     * Returns promise that resolves when file is written
     */
    public async endSession(): Promise<string | null> {
        if (!this.isActive || this.ticks.length === 0) {
            this.isActive = false;
            return null;
        }

        const endTime = Date.now();
        const duration = endTime - this.sessionStartTime;

        // Create filename: timestamp_slug.json
        const timestamp = new Date(this.sessionStartTime).toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .substring(0, 19); // YYYY-MM-DD_HH-MM-SS
        
        const safeSlug = this.currentMarketSlug.replace(/[^a-zA-Z0-9-_]/g, '_');
        const filename = `${timestamp}_${safeSlug}.json`;
        const filepath = path.join(this.dataDir, filename);

        const sessionData: SessionData = {
            sessionId: `${timestamp}_${safeSlug}`,
            startTime: new Date(this.sessionStartTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            duration: duration,
            marketSlug: this.currentMarketSlug,
            totalTicks: this.ticks.length,
            ticks: this.ticks
        };

        // Write file asynchronously (non-blocking)
        try {
            await writeFile(filepath, JSON.stringify(sessionData, null, 2), 'utf-8');
            console.log(`💾 Session data saved: ${filename} (${this.ticks.length} ticks)`);
            this.isActive = false;
            return filepath;
        } catch (error) {
            console.error('❌ Error saving session data:', error);
            this.isActive = false;
            return null;
        }
    }

    /**
     * Get current session stats (for display)
     */
    public getSessionStats(): { tickCount: number; marketSlug: string; duration: number } {
        return {
            tickCount: this.ticks.length,
            marketSlug: this.currentMarketSlug,
            duration: this.isActive ? Date.now() - this.sessionStartTime : 0
        };
    }

    /**
     * Check if logger is active
     */
    public isSessionActive(): boolean {
        return this.isActive;
    }
}

