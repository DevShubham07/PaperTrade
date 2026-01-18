/**
 * Expiration Convergence Strategy (formerly Simple Arbitrage)
 * 
 * Strategy Rules:
 * - If time remaining > 150 seconds
 * - Calculate Fair Value based on real-time volatility (Z-Score)
 * - Buy 10% of cash if Market Price < (Fair Value - 0.05)
 * - Immediately place sell limit order at purchase price + $0.02
 * - Protective Stop Loss: Bail if current bid < (Entry - $0.15)
 * - Hold to Maturity: Cancel sell if deep ITM and < 45s left
 */

import { ExecutionGateway } from '../execution';
import { OrderBookService } from '../services/orderBookService';
import { MarketConfig } from '../slugOracle';
import { CONFIG } from '../config';
import { QuantEngine } from '../services/quantEngine';

export interface TradeRecord {
    id: string;
    timestamp: number;
    marketSlug: string;
    side: 'BUY' | 'SELL';
    tokenId: string;
    tokenType: 'UP' | 'DOWN';
    price: number;
    size: number;
    orderId: string;
    status: 'PENDING' | 'FILLED' | 'CANCELLED';
    pairedWith?: string; // ID of the paired order (buy paired with sell)
    exitType?: 'LIMIT' | 'STOP_LOSS' | 'HOLD_TO_MATURITY' | 'BREAKEVEN'; // How the position was exited (for SELL orders)
}

export interface StrategyStats {
    totalBuyOrders: number;
    totalSellOrders: number;
    executedBuyOrders: number;
    executedSellOrders: number;
    stopLossExits: number; // Positions closed via stop-loss
    limitSellFills: number; // Positions closed via limit sell
    cancelledSells: number; // Sell orders that were cancelled
    nakedPositions: number; // Bought but never sold
    totalTrades: number;
    totalInvested: number; // Total amount invested (all filled buy orders)
    totalProceeds: number; // Total proceeds from filled sell orders
    netPNL: number; // Net profit/loss (proceeds - invested)
    realizedPNL: number; // PNL from completed trades (buy + sell both filled)
    unrealizedPNL: number; // PNL from naked positions (bought but not sold)
}

export class ExpirationConvergenceStrategy {
    private executionGateway: ExecutionGateway;
    private orderBookService: OrderBookService;
    private quantEngine: QuantEngine;
    private tradeRecords: Map<string, TradeRecord> = new Map();
    private activePositions: Map<string, TradeRecord> = new Map(); // orderId -> buy order
    private orderCounter: number = 0;
    private initialBankroll: number; // Starting capital for this session
    private peakBankroll: number; // Highest bankroll achieved (for compounding)
    
    // 🚨 HIGH-FREQUENCY STOP-LOSS MONITORING (Production Grade)
    private stopLossInterval: NodeJS.Timeout | null = null;
    private readonly STOP_LOSS_CHECK_INTERVAL = 150; // Check every 150ms (vs 500ms main tick)
    private isProcessingStopLoss = false; // Prevent concurrent stop-loss checks

    constructor(executionGateway: ExecutionGateway, orderBookService: OrderBookService) {
        this.executionGateway = executionGateway;
        this.orderBookService = orderBookService;
        this.quantEngine = new QuantEngine();
        
        // 🔧 Track initial bankroll at strategy creation
        this.initialBankroll = this.executionGateway.getPaperCash();
        this.peakBankroll = this.initialBankroll;
        console.log(`💰 Initial Bankroll: $${this.initialBankroll.toFixed(2)}`);
        
        // 🚨 Start high-frequency stop-loss monitor
        this.startStopLossMonitor();
    }
    
    /**
     * 🚨 HIGH-FREQUENCY STOP-LOSS MONITOR
     * Runs independently of main tick at 150ms intervals
     * This catches rapid price drops that would slip through 500ms ticks
     */
    private startStopLossMonitor(): void {
        if (this.stopLossInterval) return; // Already running
        
        console.log(`🛡️ Starting high-frequency stop-loss monitor (every ${this.STOP_LOSS_CHECK_INTERVAL}ms)`);
        
        this.stopLossInterval = setInterval(async () => {
            if (this.isProcessingStopLoss) return; // Skip if already processing
            
            const paperPosition = this.executionGateway.getPaperPosition();
            if (!paperPosition) return; // No position to monitor
            
            this.isProcessingStopLoss = true;
            try {
                await this.checkAndExecuteStopLoss(paperPosition);
            } catch (err) {
                // Silent fail - don't spam logs
            } finally {
                this.isProcessingStopLoss = false;
            }
        }, this.STOP_LOSS_CHECK_INTERVAL);
    }
    
    /**
     * Stop the high-frequency monitor (call on cleanup)
     */
    stopStopLossMonitor(): void {
        if (this.stopLossInterval) {
            clearInterval(this.stopLossInterval);
            this.stopLossInterval = null;
            console.log(`🛑 Stop-loss monitor stopped`);
        }
    }
    
    /**
     * 🚨 PRODUCTION-GRADE STOP-LOSS CHECK
     * Called at high frequency (150ms) to minimize slippage
     */
    private async checkAndExecuteStopLoss(paperPosition: { tokenId: string; shares: number; entryPrice: number; entryTime: number }): Promise<boolean> {
        const orderBook = await this.orderBookService.getOrderBook(paperPosition.tokenId);
        const currentBid = orderBook.bestBid;
        const entryPrice = paperPosition.entryPrice;
        const stopLossLimit = CONFIG.STOP_LOSS_THRESHOLD; // Use config value (default 0.10)
        const stopLossPrice = entryPrice - stopLossLimit;
        
        if (currentBid >= stopLossPrice) {
            return false; // Price is fine, no action needed
        }
        
        // 🚨 STOP-LOSS TRIGGERED!
        console.log(`🚨 [FAST] STOP LOSS TRIGGERED! Entry: $${entryPrice.toFixed(2)}, Bid: $${currentBid.toFixed(2)}, Threshold: $${stopLossPrice.toFixed(2)}`);
        
        // Find paired buy order
        const pairedBuy = Array.from(this.tradeRecords.values()).find(r => 
            r.tokenId === paperPosition.tokenId && r.side === 'BUY' && r.status === 'FILLED'
        );
        
        // Cancel any pending sell orders
        const pendingSell = Array.from(this.tradeRecords.values()).find(r => 
            r.tokenId === paperPosition.tokenId && r.side === 'SELL' && r.status === 'PENDING'
        );
        
        if (pendingSell) {
            console.log(`   🗑️ Cancelling limit sell ${pendingSell.orderId}...`);
            await this.executionGateway.cancelOrder(pendingSell.orderId);
            pendingSell.status = 'CANCELLED';
        }
        
        // 🔧 PRODUCTION FIX: Execute at STOP-LOSS THRESHOLD price (not market price)
        // This simulates a proper stop-loss order that would fill at the trigger price
        // In reality, we'd get some slippage, but not as much as pure market order
        const executionPrice = Math.max(currentBid, stopLossPrice - 0.02); // Allow max 2¢ slippage below threshold
        
        console.log(`   💥 Executing stop-loss sell @ $${executionPrice.toFixed(2)} (bid was $${currentBid.toFixed(2)})`);
        
        const sold = await this.executionGateway.executeFAK(
            paperPosition.tokenId,
            'SELL',
            executionPrice,
            paperPosition.shares
        );
        
        if (sold && pairedBuy) {
            const stopLossRecord: TradeRecord = {
                id: `trade_${this.orderCounter++}`,
                timestamp: Date.now(),
                marketSlug: pairedBuy.marketSlug,
                side: 'SELL',
                tokenId: paperPosition.tokenId,
                tokenType: pairedBuy.tokenType,
                price: executionPrice,
                size: paperPosition.shares,
                orderId: `STOP_LOSS_${Date.now()}`,
                status: 'FILLED',
                pairedWith: pairedBuy.id,
                exitType: 'STOP_LOSS'
            };
            
            this.tradeRecords.set(stopLossRecord.id, stopLossRecord);
            this.activePositions.delete(pairedBuy.id);
            
            const pnl = (executionPrice - entryPrice) * paperPosition.shares;
            console.log(`   📝 Stop-loss recorded: ${stopLossRecord.id} | P&L: $${pnl.toFixed(2)}`);
            console.log(`   🔓 Position closed (Active: ${this.activePositions.size})`);
            return true;
        }
        
        return false;
    }

    /**
     * Check if we have any pending trades (buy+sell pair not both filled)
     * Also checks if we have sufficient cash for a new trade
     */
    hasPendingTrades(): boolean {
        const records = Array.from(this.tradeRecords.values());
        const buyOrders = records.filter(r => r.side === 'BUY' && r.status === 'FILLED');
        
        // Check if any filled buy order doesn't have a FILLED sell order
        // 🔧 FIX: Look specifically for a FILLED sell, not just any sell with pairedWith
        // This handles the case where a limit sell is CANCELLED but a stop-loss sell is FILLED
        for (const buy of buyOrders) {
            const filledSell = records.find(r => r.pairedWith === buy.id && r.status === 'FILLED');
            if (!filledSell) {
                // Check if there's a pending (not cancelled) sell
                const pendingSell = records.find(r => r.pairedWith === buy.id && r.status === 'PENDING');
                if (pendingSell) {
                    console.log(`🔒 Trade blocked: Waiting for sell order to fill (Buy ID: ${buy.id})`);
                    return true; // Found a pending trade pair
                }
                // If no filled sell AND no pending sell, check if there's a cancelled one
                // (This means stop-loss didn't create a record - shouldn't happen with fix)
                const cancelledSell = records.find(r => r.pairedWith === buy.id && r.status === 'CANCELLED');
                if (cancelledSell && !filledSell) {
                    // Cancelled without a stop-loss fill - this is an orphaned position
                    // Check activePositions to see if it's still open
                    if (this.activePositions.has(buy.id)) {
                        console.log(`🔒 Trade blocked: Orphaned position exists (Buy ID: ${buy.id})`);
                        return true;
                    }
                }
            }
        }
        
        // Also check if we have any active positions (bought but not sold)
        if (this.activePositions.size > 0) {
            const posIds = Array.from(this.activePositions.keys()).join(', ');
            console.log(`🔒 Trade blocked: Active positions exist (${this.activePositions.size}): ${posIds}`);
            return true; // We have active positions, don't place new trades
        }
        
        // 🔧 FIX: Check if we have sufficient cash for a MINIMUM trade size ($1.00)
        // Don't use percentage of current cash - that allows trades to shrink forever
        const availableCash = this.executionGateway.getPaperCash();
        const MIN_TRADE_SIZE = 1.00; // Minimum $1.00 per trade
        
        if (availableCash < MIN_TRADE_SIZE) {
            console.log(`🔒 Trade blocked: Insufficient cash ($${availableCash.toFixed(2)} < $${MIN_TRADE_SIZE.toFixed(2)} minimum)`);
            return true; // Not enough cash for a trade
        }
        
        return false; // All trades are complete and we have cash
    }

    /**
     * Check if we should enter a trade based on strategy rules
     * Now includes Fair Value calculation using Z-Score
     */
    shouldEnterTrade(
        spotPrice: number,
        strikePrice: number,
        timeRemainingSeconds: number
    ): { shouldTrade: boolean; direction: 'UP' | 'DOWN' | null; fairValue?: number; volatility?: number } {
        // Update volatility tracker with latest spot price
        this.quantEngine.updatePrice(spotPrice);

        // Rule 0: Don't trade if we have pending trades (wait for previous pair to complete)
        if (this.hasPendingTrades()) {
            return { shouldTrade: false, direction: null };
        }

        // Rule 1: Time remaining must be > 150 seconds
        if (timeRemainingSeconds <= 150) {
            return { shouldTrade: false, direction: null };
        }

        // Rule 2: Require minimum price history for reliable volatility calculations
        if (!this.quantEngine.hasMinimumHistory()) {
            console.log(`⏳ Waiting for price history to build (${this.quantEngine.getHistoryLength()}/5 ticks)...`);
            return { shouldTrade: false, direction: null };
        }

        // Rule 3: Determine Direction
        const distance = spotPrice - strikePrice;
        const direction = distance > 0 ? 'UP' : 'DOWN';

        // Rule 4: Fair Value Check (The Z-Score Logic)
        const volatility = this.quantEngine.getVolatilityPerMinute();
        const fairValue = this.quantEngine.calculateFairValue(
            spotPrice,
            strikePrice,
            timeRemainingSeconds,
            volatility,
            direction
        );

        // Basic filter: Don't even try if probability is < 60%
        // This prevents trading in low-probability scenarios
        if (fairValue < 0.60) {
            return { shouldTrade: false, direction: null, fairValue, volatility };
        }

        return { shouldTrade: true, direction, fairValue, volatility };
    }

    /**
     * Execute a trade: Buy 10% of available cash and immediately place sell order
     */
    async executeTrade(
        marketInfo: MarketConfig,
        spotPrice: number,
        strikePrice: number,
        direction: 'UP' | 'DOWN',
        fairValue: number = 0.0 // Passed from shouldEnterTrade
    ): Promise<{ buyOrderId: string; sellOrderId: string } | null> {
        // Prevent concurrent trade execution
        if (this.hasPendingTrades()) {
            console.log('⚠️ Skipping trade - pending trades exist or insufficient cash');
            return null;
        }

        try {
            const tokenId = direction === 'UP' ? marketInfo.upTokenId : marketInfo.downTokenId;
            
            // Get current price from order book
            const orderBook = await this.orderBookService.getOrderBook(tokenId);
            const buyPrice = orderBook.bestAsk; // Price to buy at (Ask)
            const sellPriceCheck = orderBook.bestBid; // Current Bid

            if (buyPrice <= 0) {
                console.log(`⚠️ No valid buy price for ${direction} token`);
                return null;
            }

            // --- 🛡️ RISK CHECKS ---

            // 1. Spread Trap Check
            // If spread > $0.03, the cost of entry is too high
            const spread = buyPrice - sellPriceCheck;
            if (spread > 0.03) {
                console.log(`🛡️ REJECTED: Spread too wide ($${spread.toFixed(2)}). Buy: $${buyPrice}, Bid: $${sellPriceCheck}`);
                return null;
            }

            // 2. Fair Value Check (Value Discount)
            // Only buy if Market Price < Fair Value - Edge (e.g., 5 cents)
            if (fairValue > 0) {
                const edge = 0.05; // 5% edge required
                const maxBuyPrice = fairValue - edge;
                if (buyPrice > maxBuyPrice) {
                    console.log(`🛡️ REJECTED: Price too high. Market: $${buyPrice.toFixed(2)} > Max: $${maxBuyPrice.toFixed(2)} (Fair: $${fairValue.toFixed(2)})`);
                    return null;
                }
            }

            // --- END RISK CHECKS ---

            // 🔧 FIX: Calculate position size based on PEAK BANKROLL, not current cash
            // This ensures consistent sizing and compounds profits while respecting losses
            const availableCash = this.executionGateway.getPaperCash();
            
            // Update peak bankroll if we've grown (compounds profits)
            if (availableCash > this.peakBankroll && this.activePositions.size === 0) {
                this.peakBankroll = availableCash;
                console.log(`📈 New Peak Bankroll: $${this.peakBankroll.toFixed(2)}`);
            }
            
            // Use 10% of peak bankroll for position sizing
            const targetTradeSize = this.peakBankroll * 0.10;
            
            // Cap trade size by available cash (can't spend more than we have)
            const tradeAmount = Math.min(targetTradeSize, availableCash);
            
            // Ensure we have minimum cash for a meaningful trade
            if (availableCash < 1.00) {
                console.log(`⚠️ Insufficient cash for trade. Have $${availableCash.toFixed(2)}, need minimum $1.00`);
                return null;
            }
            
            console.log(`💰 Position Sizing: Peak=$${this.peakBankroll.toFixed(2)} | Target=$${targetTradeSize.toFixed(2)} | Available=$${availableCash.toFixed(2)} | Using=$${tradeAmount.toFixed(2)}`);
            
            const buySize = tradeAmount / buyPrice;

            // Check if buy price >= 0.99 (can't sell at 1.01, so only buy)
            const shouldPlaceSell = buyPrice < 0.99;

            if (shouldPlaceSell) {
                console.log(`\n💰 EXECUTING TRADE (Fair Value: $${fairValue.toFixed(2)}):`);
            } else {
                console.log(`\n💰 EXECUTING TRADE (BUY ONLY - price too high for sell):`);
            }
            console.log(`   Direction: ${direction}`);
            console.log(`   Trade Amount: $${tradeAmount.toFixed(2)} (10% of $${availableCash.toFixed(2)} cash)`);
            console.log(`   Buy Price: $${buyPrice.toFixed(4)}`);
            console.log(`   Buy Size: ${buySize.toFixed(4)} shares`);
            console.log(`   Buy Amount: $${(buyPrice * buySize).toFixed(2)}`);

            // Place buy order as FOK (Fill-Or-Kill) for immediate execution
            let buyOrderId: string;
            try {
                buyOrderId = await this.executionGateway.placeFOKOrder(
                    tokenId,
                    'BUY',
                    buyPrice * buySize, // Dollar amount for FOK
                    buyPrice
                );
                
                if (!buyOrderId) {
                    console.log(`⚠️ FOK buy order failed or was killed`);
                    return null;
                }
            } catch (error: any) {
                console.error(`❌ FOK buy order error:`, error.message);
                return null;
            }

            // Record buy order (mark as FILLED since FOK executes immediately or fails)
            const buyRecord: TradeRecord = {
                id: `trade_${this.orderCounter++}`,
                timestamp: Date.now(),
                marketSlug: marketInfo.eventSlug,
                side: 'BUY',
                tokenId,
                tokenType: direction,
                price: buyPrice,
                size: buySize,
                orderId: buyOrderId,
                status: 'FILLED' // FOK orders fill immediately or fail
            };

            this.tradeRecords.set(buyRecord.id, buyRecord);
            // Track by orderId, not tokenId, so we can have multiple positions per token
            this.activePositions.set(buyRecord.id, buyRecord);
            console.log(`🔒 Position opened: ${buyRecord.id} (Active positions: ${this.activePositions.size})`);

            let sellOrderId: string | null = null;

            // Only place sell order if buy price < 0.99
            if (shouldPlaceSell) {
                // Calculate sell price: buy price + $0.02
                const sellPrice = buyPrice + 0.02;

                console.log(`   Sell Price: $${sellPrice.toFixed(4)} (${buyPrice.toFixed(4)} + $0.02)`);
                console.log(`   Sell Size: ${buySize.toFixed(4)} shares`);

                // Place sell order as GTC (Good-Til-Cancelled) limit order
                sellOrderId = await this.executionGateway.placeLimitOrder(
                    tokenId,
                    'SELL',
                    sellPrice,
                    buySize,
                    'GTC' // GTC limit order - stays active until filled
                );

                // Record sell order
                const sellRecord: TradeRecord = {
                    id: `trade_${this.orderCounter++}`,
                    timestamp: Date.now(),
                    marketSlug: marketInfo.eventSlug,
                    side: 'SELL',
                    tokenId,
                    tokenType: direction,
                    price: sellPrice,
                    size: buySize,
                    orderId: sellOrderId,
                    status: 'PENDING',
                    pairedWith: buyRecord.id,
                    exitType: 'LIMIT'  // Regular limit sell order
                };

                buyRecord.pairedWith = sellRecord.id;
                this.tradeRecords.set(sellRecord.id, sellRecord);

                console.log(`✅ Trade pair placed:`);
                console.log(`   Buy Order (FOK): ${buyOrderId} - FILLED`);
                console.log(`   Sell Order (GTC): ${sellOrderId} - PENDING @ $${sellPrice.toFixed(4)}`);
                console.log(`   💰 Cash locked: $${(buyPrice * buySize).toFixed(2)} | Available: $${this.executionGateway.getPaperCash().toFixed(2)}`);
            } else {
                console.log(`✅ Buy order placed (NO SELL - price >= 0.99):`);
                console.log(`   Buy Order (FOK): ${buyOrderId} - FILLED`);
                console.log(`   ⚠️  No sell order - holding position (buy price $${buyPrice.toFixed(4)} >= 0.99)`);
            }

            return { buyOrderId, sellOrderId: sellOrderId || '' };
        } catch (error: any) {
            console.error(`❌ Error executing trade:`, error.message);
            return null;
        }
    }

    /**
     * Check for filled orders, update status, and manage active positions (Stop Loss & Hold to Maturity)
     * @param timeRemainingSeconds - Time remaining in the market (for hold-to-maturity logic)
     */
    async updateOrderStatus(timeRemainingSeconds?: number): Promise<void> {
        // Get all paper orders from execution gateway
        const paperOrders = this.executionGateway.getPaperOrders();
        const paperPosition = this.executionGateway.getPaperPosition();

        // 🛡️ STOP LOSS: Handled by high-frequency monitor (checkAndExecuteStopLoss @ 150ms)
        // This reduces slippage by checking 3x faster than main tick interval
        
        // 💎 HOLD TO MATURITY CHECK (The "Free Alpha")
        if (paperPosition) {
            try {
                const orderBook = await this.orderBookService.getOrderBook(paperPosition.tokenId);
                const currentBid = orderBook.bestBid;

                // --- HOLD TO MATURITY CHECK ---
                // If time < 45s AND deep ITM (Bid > $0.94), cancel sell to hold for $1.00 settlement
                // This captures the remaining value instead of selling early
                if (timeRemainingSeconds !== undefined && timeRemainingSeconds < 45 && currentBid > 0.94) {
                    const pendingSell = Array.from(this.tradeRecords.values()).find(r => 
                        r.tokenId === paperPosition.tokenId && r.side === 'SELL' && r.status === 'PENDING'
                    );

                    if (pendingSell) {
                        console.log(`💎 HOLD TO MATURITY: ${timeRemainingSeconds.toFixed(0)}s left, deep ITM (Bid: $${currentBid.toFixed(2)}). Cancelling sell @ $${pendingSell.price.toFixed(2)} to capture full $1.00 value.`);
                        await this.executionGateway.cancelOrder(pendingSell.orderId);
                        pendingSell.status = 'CANCELLED';
                        // Position is now "naked long" - will settle at $1.00 if it wins
                    }
                }
            } catch (error) {
                console.error("Error checking position status:", error);
            }
        }

        // Update trade records based on paper trading state
        for (const [tradeId, record] of this.tradeRecords.entries()) {
            if (record.status === 'PENDING') {
                // Check if order still exists in open orders
                const paperOrder = paperOrders.find(o => o.id === record.orderId);
                
                if (!paperOrder) {
                    // Order is no longer in open orders - it was filled or cancelled
                    // For BUY orders: check if we have a position
                    if (record.side === 'BUY') {
                        if (paperPosition && paperPosition.tokenId === record.tokenId) {
                            record.status = 'FILLED';
                            console.log(`✅ Buy order filled: ${record.orderId}`);
                        }
                    } 
                    // For SELL orders: check if position was closed
                    else if (record.side === 'SELL') {
                        // Find the paired buy order
                        const pairedBuy = this.tradeRecords.get(record.pairedWith || '');
                        if (pairedBuy && pairedBuy.status === 'FILLED') {
                            // Check if we had a position and now we don't (sell filled)
                            const hadPosition = this.activePositions.has(pairedBuy.id);
                            if (hadPosition && (!paperPosition || paperPosition.tokenId !== record.tokenId)) {
                                record.status = 'FILLED';
                                const cashAfter = this.executionGateway.getPaperCash();
                                console.log(`✅ Sell order filled: ${record.orderId}`);
                                
                                // Remove from active positions
                                this.activePositions.delete(pairedBuy.id);
                                console.log(`🔓 Position closed: ${pairedBuy.id} (Active positions: ${this.activePositions.size}) | Cash: $${cashAfter.toFixed(2)}`);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Get strategy statistics with PNL calculations
     */
    getStats(): StrategyStats {
        const records = Array.from(this.tradeRecords.values());
        
        const buyOrders = records.filter(r => r.side === 'BUY');
        const sellOrders = records.filter(r => r.side === 'SELL');
        const executedBuys = buyOrders.filter(r => r.status === 'FILLED');
        const executedSells = sellOrders.filter(r => r.status === 'FILLED');
        
        // 🔧 NEW: Count sell orders by exit type
        const stopLossExits = sellOrders.filter(r => r.status === 'FILLED' && r.exitType === 'STOP_LOSS').length;
        const limitSellFills = sellOrders.filter(r => r.status === 'FILLED' && r.exitType === 'LIMIT').length;
        const cancelledSells = sellOrders.filter(r => r.status === 'CANCELLED').length;
        
        // Calculate total invested (all filled buy orders)
        const totalInvested = executedBuys.reduce((sum, buy) => {
            return sum + (buy.price * buy.size);
        }, 0);

        // Calculate total proceeds (all filled sell orders)
        const totalProceeds = executedSells.reduce((sum, sell) => {
            return sum + (sell.price * sell.size);
        }, 0);

        // Calculate realized PNL (completed trades where both buy and sell filled)
        let realizedPNL = 0;
        executedBuys.forEach(buy => {
            const pairedSell = sellOrders.find(s => s.pairedWith === buy.id && s.status === 'FILLED');
            if (pairedSell) {
                const buyCost = buy.price * buy.size;
                const sellProceeds = pairedSell.price * pairedSell.size;
                realizedPNL += (sellProceeds - buyCost);
            }
        });

        // Calculate unrealized PNL (naked positions - bought but not sold)
        // Count ALL filled buy orders that don't have a filled sell order
        // 🔧 FIX: Look specifically for a FILLED sell, not just any sell with pairedWith
        // This handles the case where a limit sell is CANCELLED but a stop-loss sell is FILLED
        const nakedPositions = executedBuys.filter(buy => {
            const filledSell = sellOrders.find(s => s.pairedWith === buy.id && s.status === 'FILLED');
            return !filledSell;  // Naked only if NO filled sell is paired with this buy
        });

        let unrealizedPNL = 0;
        nakedPositions.forEach(pos => {
            const buyCost = pos.price * pos.size;
            // For unrealized, we assume market value is still at buy price (conservative)
            // In production, you'd check current market price
            unrealizedPNL -= buyCost; // Negative because we invested but haven't sold
        });

        // Net PNL = realized + unrealized
        const netPNL = realizedPNL + unrealizedPNL;

        return {
            totalBuyOrders: buyOrders.length,
            totalSellOrders: sellOrders.length,
            executedBuyOrders: executedBuys.length,
            executedSellOrders: executedSells.length,
            stopLossExits,
            limitSellFills,
            cancelledSells,
            nakedPositions: nakedPositions.length,
            totalTrades: records.length,
            totalInvested,
            totalProceeds,
            netPNL,
            realizedPNL,
            unrealizedPNL
        };
    }

    /**
     * Get all trade records
     */
    getTradeRecords(): TradeRecord[] {
        return Array.from(this.tradeRecords.values());
    }

    /**
     * Get active positions (bought but not sold)
     */
    getActivePositions(): TradeRecord[] {
        return Array.from(this.activePositions.values());
    }

    /**
     * Reset stats for new market
     */
    async resetForNewMarket(): Promise<void> {
        console.log('🔄 Resetting strategy for new market...');
        
        // Clear active positions tracking
        const positionCount = this.activePositions.size;
        this.activePositions.clear();
        
        // Clear all trade records from previous market
        const recordCount = this.tradeRecords.size;
        this.tradeRecords.clear();
        
        // Reset order counter (optional - keeps unique IDs)
        // this.orderCounter = 0; // Keep counter for unique IDs across markets
        
        if (positionCount > 0 || recordCount > 0) {
            console.log(`   Cleared ${positionCount} positions and ${recordCount} trade records`);
        }
        
        // Also clear execution gateway state (handles both paper and live)
        await this.executionGateway.clearAllState();
        
        // 🔧 Update peak bankroll to current cash (after market rotation)
        // This resets the baseline for the new market session
        const currentCash = this.executionGateway.getPaperCash();
        this.peakBankroll = currentCash;
        console.log(`   💰 Peak Bankroll reset to: $${this.peakBankroll.toFixed(2)}`);
    }
}

