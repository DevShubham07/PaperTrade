/**
 * Trade Logger Service
 * Logs all trades, orders, and statistics to a file
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyStats } from '../strategies/ExpirationConvergenceStrategy';
import { TradeRecord } from '../execution';

export class TradeLogger {
    private logDir: string;
    private currentLogFile: string | null = null;
    private sessionStartTime: Date | null = null;
    private startingCapital: number = 0;  // 💰 Track wallet at session start

    constructor(logDir: string = './logs') {
        this.logDir = logDir;
        this.ensureLogDirectory();
    }

    /**
     * Ensure log directory exists
     */
    private ensureLogDirectory(): void {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * Start a new trading session
     */
    startSession(marketSlug: string, startingCapital: number = 20): void {
        this.sessionStartTime = new Date();
        this.startingCapital = startingCapital;  // 💰 Record starting wallet
        const timestamp = this.sessionStartTime.toISOString().replace(/[:.]/g, '-');
        this.currentLogFile = path.join(this.logDir, `trades_${marketSlug}_${timestamp}.log`);
        
        this.log(`\n${'='.repeat(80)}`);
        this.log(`TRADING SESSION STARTED`);
        this.log(`Market: ${marketSlug}`);
        this.log(`Start Time: ${this.sessionStartTime.toISOString()}`);
        this.log(`💰 Starting Capital: $${this.startingCapital.toFixed(2)}`);
        this.log(`${'='.repeat(80)}\n`);
    }

    /**
     * End current trading session and write final stats
     */
    endSession(stats: StrategyStats, tradeRecords: TradeRecord[], endingCapital: number): void {
        if (!this.currentLogFile) return;

        const endTime = new Date();
        const duration = this.sessionStartTime 
            ? Math.round((endTime.getTime() - this.sessionStartTime.getTime()) / 1000)
            : 0;
        
        // 💰 Calculate wallet changes
        const capitalChange = endingCapital - this.startingCapital;
        const capitalChangePercent = this.startingCapital > 0 
            ? ((capitalChange / this.startingCapital) * 100)
            : 0;

        this.log(`\n${'='.repeat(80)}`);
        this.log(`TRADING SESSION ENDED`);
        this.log(`End Time: ${endTime.toISOString()}`);
        this.log(`Duration: ${duration} seconds`);
        this.log(`${'='.repeat(80)}\n`);

        this.log(`\n${'='.repeat(80)}`);
        this.log(`💼 WALLET SUMMARY`);
        this.log(`${'='.repeat(80)}`);
        this.log(`   Starting Capital: $${this.startingCapital.toFixed(2)}`);
        this.log(`   Ending Capital:   $${endingCapital.toFixed(2)}`);
        this.log(`   Net Change:       ${capitalChange >= 0 ? '+' : ''}$${capitalChange.toFixed(2)} (${capitalChange >= 0 ? '+' : ''}${capitalChangePercent.toFixed(2)}%)`);
        this.log(`${'='.repeat(80)}\n`);

        this.log(`\n${'='.repeat(80)}`);
        this.log(`FINAL STATISTICS`);
        this.log(`${'='.repeat(80)}`);
        this.log(`Total Buy Orders: ${stats.totalBuyOrders}`);
        this.log(`Total Sell Orders: ${stats.totalSellOrders}`);
        this.log(`Executed Buy Orders: ${stats.executedBuyOrders}`);
        this.log(`Executed Sell Orders: ${stats.executedSellOrders}`);
        this.log(`Naked Positions: ${stats.nakedPositions} (bought but never sold)`);
        this.log(`Total Trades: ${stats.totalTrades}`);
        this.log(``);
        this.log(`💰 FINANCIAL SUMMARY:`);
        this.log(`   Total Invested: $${stats.totalInvested.toFixed(2)}`);
        this.log(`   Total Proceeds: $${stats.totalProceeds.toFixed(2)}`);
        this.log(`   Realized PNL: $${stats.realizedPNL.toFixed(2)}`);
        this.log(`   Unrealized PNL: $${stats.unrealizedPNL.toFixed(2)}`);
        this.log(`   Net PNL: $${stats.netPNL.toFixed(2)} ${stats.netPNL >= 0 ? '✅' : '❌'}`);
        this.log(`${'='.repeat(80)}\n`);

        // Log all trade records
        this.log(`\n${'='.repeat(80)}`);
        this.log(`TRADE RECORDS`);
        this.log(`${'='.repeat(80)}`);
        
        const buyOrders = tradeRecords.filter(r => r.side === 'BUY');
        const sellOrders = tradeRecords.filter(r => r.side === 'SELL');

        this.log(`\nBUY ORDERS (${buyOrders.length}):`);
        buyOrders.forEach((record, index) => {
            this.log(`  ${index + 1}. [${record.status}] ${record.tokenType} @ $${record.price.toFixed(4)} | Size: ${record.size.toFixed(4)} | Order: ${record.orderId} | Time: ${new Date(record.timestamp).toISOString()}`);
        });

        this.log(`\nSELL ORDERS (${sellOrders.length}):`);
        sellOrders.forEach((record, index) => {
            this.log(`  ${index + 1}. [${record.status}] ${record.tokenType} @ $${record.price.toFixed(4)} | Size: ${record.size.toFixed(4)} | Order: ${record.orderId} | Paired: ${record.pairedWith || 'N/A'} | Time: ${new Date(record.timestamp).toISOString()}`);
        });

        // Log naked positions
        // 🔧 FIX: Look specifically for a FILLED sell to handle cancelled limit + filled stop-loss
        const nakedPositions = buyOrders.filter(buy => {
            const filledSell = sellOrders.find(s => s.pairedWith === buy.id && s.status === 'FILLED');
            return !filledSell;
        });

        if (nakedPositions.length > 0) {
            this.log(`\nNAKED POSITIONS (${nakedPositions.length}):`);
            nakedPositions.forEach((record, index) => {
                this.log(`  ${index + 1}. ${record.tokenType} @ $${record.price.toFixed(4)} | Size: ${record.size.toFixed(4)} | Order: ${record.orderId} | Time: ${new Date(record.timestamp).toISOString()}`);
            });
        }

        this.log(`\n${'='.repeat(80)}\n`);

        // Also save to JSON file
        this.saveToJSON(stats, tradeRecords, endTime, duration, endingCapital);
    }

    /**
     * Save session data to JSON file
     */
    private saveToJSON(
        stats: StrategyStats,
        tradeRecords: TradeRecord[],
        endTime: Date,
        duration: number,
        endingCapital: number
    ): void {
        if (!this.currentLogFile || !this.sessionStartTime) return;
        
        // 💰 Calculate wallet stats
        const capitalChange = endingCapital - this.startingCapital;
        const capitalChangePercent = this.startingCapital > 0 
            ? ((capitalChange / this.startingCapital) * 100)
            : 0;

        const jsonFile = this.currentLogFile.replace('.log', '.json');
        const sessionData = {
            session: {
                startTime: this.sessionStartTime.toISOString(),
                endTime: endTime.toISOString(),
                duration: duration,
                marketSlug: tradeRecords.length > 0 ? tradeRecords[0].marketSlug : 'unknown'
            },
            // 💰 NEW: Wallet tracking - shows starting and ending capital
            wallet: {
                startingCapital: parseFloat(this.startingCapital.toFixed(2)),
                endingCapital: parseFloat(endingCapital.toFixed(2)),
                netChange: parseFloat(capitalChange.toFixed(2)),
                netChangePercent: parseFloat(capitalChangePercent.toFixed(2)),
                profitable: capitalChange >= 0
            },
            statistics: {
                totalBuyOrders: stats.totalBuyOrders,
                executedBuyOrders: stats.executedBuyOrders,
                exits: {
                    limitSells: stats.limitSellFills || 0,
                    stopLosses: stats.stopLossExits || 0,
                    cancelled: stats.cancelledSells || 0,
                    total: stats.executedSellOrders
                },
                nakedPositions: stats.nakedPositions,
                totalTrades: stats.totalTrades
            },
            financial: {
                totalInvested: parseFloat(stats.totalInvested.toFixed(2)),
                totalProceeds: parseFloat(stats.totalProceeds.toFixed(2)),
                realizedPNL: parseFloat(stats.realizedPNL.toFixed(2)),
                unrealizedPNL: parseFloat(stats.unrealizedPNL.toFixed(2)),
                netPNL: parseFloat(stats.netPNL.toFixed(2)),
                roi: stats.totalInvested > 0 
                    ? parseFloat(((stats.netPNL / stats.totalInvested) * 100).toFixed(2))
                    : 0
            },
            trades: tradeRecords.map(record => ({
                id: record.id,
                timestamp: new Date(record.timestamp).toISOString(),
                marketSlug: record.marketSlug,
                side: record.side,
                tokenId: record.tokenId,
                tokenType: record.tokenType,
                price: record.price,
                size: record.size,
                amount: record.price * record.size,
                orderId: record.orderId,
                status: record.status,
                pairedWith: record.pairedWith,
                exitType: record.exitType || null  // 🔧 Include exit type (LIMIT, STOP_LOSS, etc.)
            })),
            completedTrades: this.getCompletedTrades(tradeRecords),
            nakedPositions: this.getNakedPositions(tradeRecords)
        };

        try {
            fs.writeFileSync(jsonFile, JSON.stringify(sessionData, null, 2), 'utf8');
            console.log(`💾 Session data saved to JSON: ${jsonFile}`);
        } catch (error: any) {
            console.error(`❌ Failed to save JSON file: ${error.message}`);
        }
    }

    /**
     * Get completed trades (both buy and sell filled)
     */
    private getCompletedTrades(tradeRecords: TradeRecord[]): any[] {
        const buyOrders = tradeRecords.filter(r => r.side === 'BUY' && r.status === 'FILLED');
        const completed: any[] = [];

        buyOrders.forEach(buy => {
            const sell = tradeRecords.find(r => r.pairedWith === buy.id && r.status === 'FILLED');
            if (sell) {
                const buyCost = buy.price * buy.size;
                const sellProceeds = sell.price * sell.size;
                const pnl = sellProceeds - buyCost;
                completed.push({
                    buyOrder: {
                        id: buy.id,
                        price: buy.price,
                        size: buy.size,
                        amount: buyCost,
                        timestamp: new Date(buy.timestamp).toISOString()
                    },
                    sellOrder: {
                        id: sell.id,
                        price: sell.price,
                        size: sell.size,
                        amount: sellProceeds,
                        timestamp: new Date(sell.timestamp).toISOString()
                    },
                    pnl: parseFloat(pnl.toFixed(2)),
                    roi: parseFloat(((pnl / buyCost) * 100).toFixed(2))
                });
            }
        });

        return completed;
    }

    /**
     * Get naked positions (bought but not sold)
     */
    private getNakedPositions(tradeRecords: TradeRecord[]): any[] {
        const buyOrders = tradeRecords.filter(r => r.side === 'BUY' && r.status === 'FILLED');
        const naked: any[] = [];

        buyOrders.forEach(buy => {
            const sell = tradeRecords.find(r => r.pairedWith === buy.id && r.status === 'FILLED');
            if (!sell) {
                const buyCost = buy.price * buy.size;
                naked.push({
                    buyOrder: {
                        id: buy.id,
                        price: buy.price,
                        size: buy.size,
                        amount: buyCost,
                        timestamp: new Date(buy.timestamp).toISOString()
                    },
                    invested: parseFloat(buyCost.toFixed(2)),
                    status: 'UNREALIZED'
                });
            }
        });

        return naked;
    }

    /**
     * Log a trade execution
     */
    logTrade(record: TradeRecord): void {
        const time = new Date(record.timestamp).toISOString();
        this.log(`[${time}] ${record.side} ${record.tokenType} @ $${record.price.toFixed(4)} | Size: ${record.size.toFixed(4)} | Order: ${record.orderId} | Status: ${record.status}`);
    }

    /**
     * Log strategy decision
     */
    logDecision(
        spotPrice: number,
        strikePrice: number,
        timeRemaining: number,
        shouldTrade: boolean,
        direction: 'UP' | 'DOWN' | null,
        prices?: { upAsk: number; upBid: number; downAsk: number; downBid: number },
        fairValue?: number,
        volatility?: number
    ): void {
        const diff = Math.abs(spotPrice - strikePrice);
        let message = `\n[STRATEGY CHECK] Spot: $${spotPrice.toFixed(2)} | Strike: $${strikePrice.toFixed(2)} | Diff: $${diff.toFixed(2)} | Time Left: ${timeRemaining.toFixed(0)}s`;

        if (prices) {
            message += ` | UP: $${prices.upAsk.toFixed(4)}/$${prices.upBid.toFixed(4)} | DOWN: $${prices.downAsk.toFixed(4)}/$${prices.downBid.toFixed(4)}`;
        }

        if (fairValue !== undefined && volatility !== undefined) {
            message += ` | Fair Value: $${fairValue.toFixed(4)} | Vol: $${volatility.toFixed(2)}/min`;
        }

        message += ` | Trade: ${shouldTrade ? 'YES' : 'NO'} ${direction ? `(${direction})` : ''}`;

        this.log(message);
    }

    /**
     * Log statistics update
     */
    logStats(stats: StrategyStats): void {
        // 🔧 Clearer logging: Show exit types separately
        let sellInfo = `Limit: ${stats.limitSellFills || 0}`;
        if ((stats.stopLossExits || 0) > 0) {
            sellInfo += ` | 🛑 StopLoss: ${stats.stopLossExits}`;
        }
        if ((stats.cancelledSells || 0) > 0) {
            sellInfo += ` | ❌ Cancelled: ${stats.cancelledSells}`;
        }
        
        this.log(`[STATS] Buys: ${stats.executedBuyOrders}/${stats.totalBuyOrders} | Exits: [${sellInfo}] | Naked: ${stats.nakedPositions}`);
    }

    /**
     * Write to log file
     */
    private log(message: string): void {
        if (this.currentLogFile) {
            fs.appendFileSync(this.currentLogFile, message + '\n', 'utf8');
        }
        // Also log to console
        console.log(message);
    }

    /**
     * Check if session is active
     */
    isSessionActive(): boolean {
        return this.currentLogFile !== null;
    }
}
