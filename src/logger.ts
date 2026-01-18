/**
 * Trading Logger Module
 * Logs all tick data and generates session summaries
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TickData {
    tickNumber: number;
    timestamp: string;
    timestampMs: number;
    market: {
        slug: string;
        strikePrice: number;
        endDate: string;
    };
    prices: {
        spot: number;
        bestBid: number;
        bestAsk: number;
        spread: number;
        fairValue: number;
        targetBuy: number;
    };
    state: {
        mode: 'SCANNING' | 'WORKING';
        hasPosition: boolean;
        positionShares?: number;
        positionEntryPrice?: number;
        activeOrderId?: string;
        activeOrderPrice?: number;
    };
    timeRemaining: number;
}

export interface TradeRecord {
    id: string;
    timestamp: string;
    timestampMs: number;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    pnl?: number;
    reason: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'EMERGENCY_EXIT' | 'MARKET_ROTATION';
}

export interface SessionSummary {
    sessionId: string;
    marketSlug: string;
    startTime: string;
    endTime: string;
    duration: number;
    totalTicks: number;
    tradesExecuted: number;
    pairs: {
        completed: number;  // Full round trips (buy + sell)
        naked: number;      // Buys without corresponding sells
        dissolved: number;  // Sells without corresponding buys
    };
    capital: {
        starting: number;
        ending: number;
        maxDeployed: number;
        invested: number;   // Total capital used across all trades
    };
    pnl: {
        realized: number;
        totalGross: number;
        winningTrades: number;
        losingTrades: number;
        winRate: number;
    };
    trades: TradeRecord[];
}

export class TradingLogger {
    private logsDir: string = './logs';
    private currentSessionId: string | null = null;
    private currentSessionDir: string | null = null;
    private ticks: TickData[] = [];
    private trades: TradeRecord[] = [];
    private sessionStartTime: number = 0;
    private marketSlug: string = '';
    private startingCapital: number = 100;

    constructor(logsBaseDir: string = './logs') {
        this.logsDir = logsBaseDir;
        this.ensureLogsDirectory();
    }

    /**
     * Ensures the logs directory exists
     */
    private ensureLogsDirectory(): void {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    /**
     * Starts a new logging session for a market
     */
    startSession(marketSlug: string, startingCapital: number = 100): void {
        this.sessionStartTime = Date.now();
        this.marketSlug = marketSlug;
        this.startingCapital = startingCapital;

        // Create session ID from market slug
        this.currentSessionId = `${marketSlug}_${this.sessionStartTime}`;

        // Create session directory
        this.currentSessionDir = path.join(this.logsDir, this.currentSessionId);
        if (!fs.existsSync(this.currentSessionDir)) {
            fs.mkdirSync(this.currentSessionDir, { recursive: true });
        }

        // Reset session data
        this.ticks = [];
        this.trades = [];

        console.log(`📝 Logging session started: ${this.currentSessionId}`);
    }

    /**
     * Logs a tick
     */
    logTick(tickData: TickData): void {
        if (!this.currentSessionDir) {
            return;
        }

        this.ticks.push(tickData);

        // Write ticks to file (append mode)
        const ticksFile = path.join(this.currentSessionDir, 'ticks.jsonl');
        fs.appendFileSync(ticksFile, JSON.stringify(tickData) + '\n');
    }

    /**
     * Logs a trade
     */
    logTrade(trade: TradeRecord): void {
        if (!this.currentSessionDir) {
            return;
        }

        this.trades.push(trade);

        // Write trade to file
        const tradesFile = path.join(this.currentSessionDir, 'trades.json');
        fs.writeFileSync(tradesFile, JSON.stringify(this.trades, null, 2));
    }

    /**
     * Ends the current session and generates summary
     */
    endSession(endingCapital: number): SessionSummary {
        if (!this.currentSessionId || !this.currentSessionDir) {
            throw new Error('No active session to end');
        }

        const endTime = Date.now();
        const duration = endTime - this.sessionStartTime;

        // Calculate trade statistics
        const buyTrades = this.trades.filter(t => t.side === 'BUY');
        const sellTrades = this.trades.filter(t => t.side === 'SELL');

        const completedPairs = Math.min(buyTrades.length, sellTrades.length);
        const nakedBuys = buyTrades.length - completedPairs;
        const dissolvedSells = sellTrades.length - completedPairs;

        // Calculate capital metrics
        const maxDeployed = Math.max(
            ...this.trades
                .filter(t => t.side === 'BUY')
                .map(t => t.price * t.size),
            0
        );

        const totalInvested = this.trades
            .filter(t => t.side === 'BUY')
            .reduce((sum, t) => sum + (t.price * t.size), 0);

        // Calculate P&L
        const realizedPnl = this.trades
            .filter(t => t.pnl !== undefined)
            .reduce((sum, t) => sum + (t.pnl || 0), 0);

        const tradesWithPnl = this.trades.filter(t => t.pnl !== undefined);
        const winningTrades = tradesWithPnl.filter(t => (t.pnl || 0) > 0).length;
        const losingTrades = tradesWithPnl.filter(t => (t.pnl || 0) < 0).length;
        const winRate = tradesWithPnl.length > 0
            ? (winningTrades / tradesWithPnl.length) * 100
            : 0;

        const summary: SessionSummary = {
            sessionId: this.currentSessionId,
            marketSlug: this.marketSlug,
            startTime: new Date(this.sessionStartTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            duration: duration,
            totalTicks: this.ticks.length,
            tradesExecuted: this.trades.length,
            pairs: {
                completed: completedPairs,
                naked: nakedBuys,
                dissolved: dissolvedSells
            },
            capital: {
                starting: this.startingCapital,
                ending: endingCapital,
                maxDeployed: maxDeployed,
                invested: totalInvested
            },
            pnl: {
                realized: realizedPnl,
                totalGross: endingCapital - this.startingCapital,
                winningTrades: winningTrades,
                losingTrades: losingTrades,
                winRate: winRate
            },
            trades: this.trades
        };

        // Write summary
        const summaryFile = path.join(this.currentSessionDir, 'summary.json');
        fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

        // Also update global summary
        this.updateGlobalSummary(summary);

        console.log(`📊 Session ended: ${this.currentSessionId}`);
        console.log(`   Total Ticks: ${summary.totalTicks}`);
        console.log(`   Trades: ${summary.tradesExecuted}`);
        console.log(`   Pairs: ${summary.pairs.completed} completed, ${summary.pairs.naked} naked, ${summary.pairs.dissolved} dissolved`);
        console.log(`   P&L: $${summary.pnl.realized.toFixed(2)}`);

        return summary;
    }

    /**
     * Updates the global summary file with all sessions
     */
    private updateGlobalSummary(sessionSummary: SessionSummary): void {
        const globalSummaryFile = path.join(this.logsDir, 'summary.json');

        let globalSummary: any = {
            sessions: [],
            totals: {
                totalSessions: 0,
                totalTicks: 0,
                totalTrades: 0,
                totalPairsCompleted: 0,
                totalNaked: 0,
                totalDissolved: 0,
                totalPnL: 0,
                totalInvested: 0,
                overallWinRate: 0
            }
        };

        // Load existing summary if it exists
        if (fs.existsSync(globalSummaryFile)) {
            try {
                globalSummary = JSON.parse(fs.readFileSync(globalSummaryFile, 'utf-8'));
            } catch (error) {
                console.warn('⚠️ Could not parse existing global summary, creating new one');
            }
        }

        // Add this session
        globalSummary.sessions.push({
            sessionId: sessionSummary.sessionId,
            marketSlug: sessionSummary.marketSlug,
            startTime: sessionSummary.startTime,
            duration: sessionSummary.duration,
            ticks: sessionSummary.totalTicks,
            trades: sessionSummary.tradesExecuted,
            pnl: sessionSummary.pnl.realized
        });

        // Update totals
        globalSummary.totals.totalSessions = globalSummary.sessions.length;
        globalSummary.totals.totalTicks += sessionSummary.totalTicks;
        globalSummary.totals.totalTrades += sessionSummary.tradesExecuted;
        globalSummary.totals.totalPairsCompleted += sessionSummary.pairs.completed;
        globalSummary.totals.totalNaked += sessionSummary.pairs.naked;
        globalSummary.totals.totalDissolved += sessionSummary.pairs.dissolved;
        globalSummary.totals.totalPnL += sessionSummary.pnl.realized;
        globalSummary.totals.totalInvested += sessionSummary.capital.invested;

        // Calculate overall win rate
        const allWins = globalSummary.sessions.reduce((sum: number, s: any) =>
            sum + (s.pnl > 0 ? 1 : 0), 0);
        globalSummary.totals.overallWinRate = globalSummary.sessions.length > 0
            ? (allWins / globalSummary.sessions.length) * 100
            : 0;

        // Write global summary
        fs.writeFileSync(globalSummaryFile, JSON.stringify(globalSummary, null, 2));
    }

    /**
     * Gets the current session directory
     */
    getCurrentSessionDir(): string | null {
        return this.currentSessionDir;
    }
}
