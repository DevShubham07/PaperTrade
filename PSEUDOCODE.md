# 📋 Bot Pseudocode

*Complete algorithmic logic for the Expiration Convergence Trading Bot*

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN LOOP (500ms)                           │
│                                                                     │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐               │
│  │ SpotPrice   │   │ MarketInfo  │   │ OrderBook   │               │
│  │ Service     │   │ Service     │   │ Service     │               │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘               │
│         │                 │                 │                       │
│         └─────────────────┴─────────────────┘                       │
│                           │                                         │
│                    ┌──────▼──────┐                                  │
│                    │   STRATEGY  │◄───── Stop-Loss Monitor (150ms)  │
│                    └──────┬──────┘                                  │
│                           │                                         │
│                    ┌──────▼──────┐                                  │
│                    │  EXECUTION  │                                  │
│                    │   GATEWAY   │                                  │
│                    └─────────────┘                                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Main Loop

```pseudocode
FUNCTION mainLoop():
    EVERY 500ms:
        
        // 1. DATA COLLECTION
        spotPrice = fetchBTCSpotPrice()
        marketInfo = getActiveMarket()
        strikePrice = marketInfo.strikePrice
        timeRemaining = calculateTimeRemaining(marketInfo.endDate)
        
        // 2. MARKET ROTATION CHECK
        IF marketInfo.slug != lastMarketSlug:
            IF lastMarketSlug != NULL:
                emergencyExitOpenPositions()
                saveSessionData()
            ENDIF
            resetStrategyState()
            startNewSession(marketInfo.slug)
            lastMarketSlug = marketInfo.slug
        ENDIF
        
        // 3. FETCH TOKEN PRICES
        upOrderBook = getOrderBook(marketInfo.upTokenId)
        downOrderBook = getOrderBook(marketInfo.downTokenId)
        
        // 4. CHECK FOR FILLED ORDERS (Credit Cash)
        checkPaperFills(upTokenId, upAsk, upBid)
        checkPaperFills(downTokenId, downAsk, downBid)
        
        // 5. UPDATE ORDER STATUS (Stop-Loss, Hold-to-Maturity)
        updateOrderStatus(timeRemaining)
        
        // 6. STRATEGY DECISION
        decision = shouldEnterTrade(spotPrice, strikePrice, timeRemaining)
        
        // 7. KILL ZONE CHECK
        killZoneActive = isInKillZone(upAsk, upBid, downAsk, downBid)
        
        // 8. TRADE EXECUTION
        IF decision.shouldTrade AND NOT killZoneActive:
            executeTrade(marketInfo, spotPrice, strikePrice, decision.direction)
        ENDIF
        
        // 9. LOGGING
        logStats()
        logTick()
    
    END EVERY
END FUNCTION
```

---

## 📐 Fair Value Calculation (Quant Engine)

```pseudocode
FUNCTION calculateFairValue(spotPrice, strikePrice, timeSeconds, volatility, direction):
    
    // Step 1: Handle expiration edge case
    IF timeSeconds <= 0:
        IF direction == "UP" AND spotPrice > strikePrice:
            RETURN 1.00  // Token settles at $1
        ELSE IF direction == "DOWN" AND spotPrice < strikePrice:
            RETURN 1.00
        ELSE:
            RETURN 0.00  // Token expires worthless
        ENDIF
    ENDIF
    
    // Step 2: Calculate distance from strike
    IF direction == "UP":
        distance = spotPrice - strikePrice    // Positive = winning
    ELSE:
        distance = strikePrice - spotPrice    // Positive = winning
    ENDIF
    
    // Step 3: Calculate expected move using √time rule
    timeInMinutes = MAX(0.01, timeSeconds / 60)
    expectedMove = volatility * SQRT(timeInMinutes)
    
    // Step 4: Calculate Z-Score
    zScore = distance / expectedMove
    
    // Step 5: Convert Z-Score to probability (Normal CDF)
    probability = normalCDF(zScore)
    
    RETURN probability  // Fair value = probability
    
END FUNCTION


FUNCTION getVolatilityPerMinute():
    
    // Need minimum 5 price points
    IF priceHistory.length < 5:
        RETURN 10.00  // Default volatility
    ENDIF
    
    // Step 1: Calculate price changes between ticks
    changes = []
    FOR i = 1 TO priceHistory.length - 1:
        delta = priceHistory[i].price - priceHistory[i-1].price
        changes.APPEND(delta)
    END FOR
    
    // Step 2: Calculate standard deviation of changes
    mean = SUM(changes) / changes.length
    variance = SUM((change - mean)^2 FOR change IN changes) / changes.length
    stdDevPerTick = SQRT(variance)
    
    // Step 3: Scale to 1 minute using √time rule
    timeSpan = (lastTimestamp - firstTimestamp) / 1000  // seconds
    ticksPerMinute = (priceHistory.length / timeSpan) * 60
    volatilityPerMinute = stdDevPerTick * SQRT(ticksPerMinute)
    
    // Step 4: Floor at $5.00 (prevent overconfidence)
    RETURN MAX(5.00, volatilityPerMinute)
    
END FUNCTION


FUNCTION normalCDF(z):
    // Abramowitz & Stegun approximation
    p = 0.2316419
    b1 = 0.319381530
    b2 = -0.356563782
    b3 = 1.781477937
    b4 = -1.821255978
    b5 = 1.330274429
    
    t = 1 / (1 + p * ABS(z))
    
    polynomial = b1*t + b2*t^2 + b3*t^3 + b4*t^4 + b5*t^5
    result = 1 - (1/SQRT(2*PI)) * EXP(-z^2/2) * polynomial
    
    IF z >= 0:
        RETURN result
    ELSE:
        RETURN 1 - result
    ENDIF
    
END FUNCTION
```

---

## 🎯 Trade Entry Logic

```pseudocode
FUNCTION shouldEnterTrade(spotPrice, strikePrice, timeSeconds):
    
    // Update volatility tracker
    quantEngine.updatePrice(spotPrice)
    
    // Rule 0: Check for pending trades
    IF hasPendingTrades():
        RETURN { shouldTrade: FALSE, direction: NULL }
    ENDIF
    
    // Rule 1: Time gate (must have > 150 seconds left)
    IF timeSeconds <= 150:
        RETURN { shouldTrade: FALSE, direction: NULL }
    ENDIF
    
    // Rule 2: Require minimum price history (5 ticks)
    IF quantEngine.historyLength < 5:
        LOG("Waiting for price history...")
        RETURN { shouldTrade: FALSE, direction: NULL }
    ENDIF
    
    // Rule 3: Determine direction
    distance = spotPrice - strikePrice
    direction = distance > 0 ? "UP" : "DOWN"
    
    // Rule 4: Calculate fair value
    volatility = quantEngine.getVolatilityPerMinute()
    fairValue = calculateFairValue(spotPrice, strikePrice, timeSeconds, volatility, direction)
    
    // Rule 5: Probability filter (must be >= 60%)
    IF fairValue < 0.60:
        RETURN { shouldTrade: FALSE, direction: NULL, fairValue, volatility }
    ENDIF
    
    RETURN { shouldTrade: TRUE, direction, fairValue, volatility }
    
END FUNCTION


FUNCTION hasPendingTrades():
    
    // Check for any filled buy without a filled sell
    FOR EACH buyOrder IN filledBuyOrders:
        filledSell = findFilledSellPairedWith(buyOrder.id)
        IF filledSell == NULL:
            pendingSell = findPendingSellPairedWith(buyOrder.id)
            IF pendingSell != NULL:
                RETURN TRUE  // Waiting for sell to fill
            ENDIF
        ENDIF
    END FOR
    
    // Check for active positions
    IF activePositions.size > 0:
        RETURN TRUE
    ENDIF
    
    // Check minimum cash
    IF availableCash < 1.00:
        RETURN TRUE  // Insufficient funds
    ENDIF
    
    RETURN FALSE
    
END FUNCTION
```

---

## 💰 Trade Execution

```pseudocode
FUNCTION executeTrade(marketInfo, spotPrice, strikePrice, direction, fairValue):
    
    // Prevent concurrent execution
    IF hasPendingTrades():
        RETURN NULL
    ENDIF
    
    // Get token and order book
    tokenId = direction == "UP" ? marketInfo.upTokenId : marketInfo.downTokenId
    orderBook = getOrderBook(tokenId)
    buyPrice = orderBook.bestAsk
    currentBid = orderBook.bestBid
    
    // VALIDATION CHECKS
    IF buyPrice <= 0:
        RETURN NULL  // No valid price
    ENDIF
    
    // Check 1: Spread must be <= $0.03
    spread = buyPrice - currentBid
    IF spread > 0.03:
        LOG("REJECTED: Spread too wide")
        RETURN NULL
    ENDIF
    
    // Check 2: Price must be below (FairValue - 5¢ edge)
    maxBuyPrice = fairValue - 0.05
    IF buyPrice > maxBuyPrice:
        LOG("REJECTED: Price too high")
        RETURN NULL
    ENDIF
    
    // POSITION SIZING
    availableCash = getAvailableCash()
    
    // Update peak bankroll for compounding
    IF availableCash > peakBankroll AND activePositions.size == 0:
        peakBankroll = availableCash
    ENDIF
    
    // Calculate trade size (10% of peak bankroll)
    targetSize = peakBankroll * 0.10
    tradeAmount = MIN(targetSize, availableCash)
    buySize = tradeAmount / buyPrice
    
    IF availableCash < 1.00:
        RETURN NULL  // Minimum $1 trade
    ENDIF
    
    // EXECUTE BUY (FOK - Fill-Or-Kill)
    buyOrderId = placeFOKOrder(tokenId, "BUY", tradeAmount, buyPrice)
    
    IF buyOrderId == NULL:
        RETURN NULL  // Order failed
    ENDIF
    
    // Record buy order
    buyRecord = createTradeRecord("BUY", tokenId, buyPrice, buySize, "FILLED")
    activePositions.ADD(buyRecord)
    
    // PLACE SELL ORDER (if price < $0.99)
    IF buyPrice < 0.99:
        sellPrice = buyPrice + 0.02  // $0.02 profit target
        sellOrderId = placeLimitOrder(tokenId, "SELL", sellPrice, buySize, "GTC")
        
        sellRecord = createTradeRecord("SELL", tokenId, sellPrice, buySize, "PENDING")
        sellRecord.pairedWith = buyRecord.id
        sellRecord.exitType = "LIMIT"
    ENDIF
    
    RETURN { buyOrderId, sellOrderId }
    
END FUNCTION
```

---

## 🛡️ Stop-Loss Monitor (High Frequency)

```pseudocode
// Runs every 150ms (independent of main loop)

FUNCTION stopLossMonitor():
    EVERY 150ms:
        
        IF isProcessingStopLoss:
            CONTINUE  // Skip if already processing
        ENDIF
        
        position = getPaperPosition()
        IF position == NULL:
            CONTINUE  // No position to monitor
        ENDIF
        
        isProcessingStopLoss = TRUE
        
        TRY:
            checkAndExecuteStopLoss(position)
        FINALLY:
            isProcessingStopLoss = FALSE
        END TRY
        
    END EVERY
END FUNCTION


FUNCTION checkAndExecuteStopLoss(position):
    
    orderBook = getOrderBook(position.tokenId)
    currentBid = orderBook.bestBid
    entryPrice = position.entryPrice
    
    // Calculate stop-loss threshold (10% below entry)
    stopLossThreshold = CONFIG.STOP_LOSS_THRESHOLD  // Default: 0.10
    stopLossPrice = entryPrice - stopLossThreshold
    
    // Check if stop-loss triggered
    IF currentBid >= stopLossPrice:
        RETURN FALSE  // Price is fine
    ENDIF
    
    // ⚠️ STOP-LOSS TRIGGERED!
    LOG("🚨 STOP LOSS TRIGGERED!")
    
    // Cancel any pending limit sell
    pendingSell = findPendingSellForPosition(position)
    IF pendingSell != NULL:
        cancelOrder(pendingSell.orderId)
        pendingSell.status = "CANCELLED"
    ENDIF
    
    // Execute stop-loss with slippage cap
    // Max 2¢ slippage below threshold
    slippageCap = CONFIG.STOP_LOSS_SLIPPAGE_CAP  // Default: 0.02
    executionPrice = MAX(currentBid, stopLossPrice - slippageCap)
    
    // Execute emergency sell
    success = executeFAK(position.tokenId, "SELL", executionPrice, position.shares)
    
    IF success:
        // Record stop-loss exit
        stopLossRecord = createTradeRecord("SELL", position.tokenId, executionPrice, position.shares, "FILLED")
        stopLossRecord.exitType = "STOP_LOSS"
        stopLossRecord.pairedWith = pairedBuyOrder.id
        
        activePositions.REMOVE(pairedBuyOrder.id)
        
        pnl = (executionPrice - entryPrice) * position.shares
        LOG("Stop-loss recorded. P&L: " + pnl)
    ENDIF
    
    RETURN success
    
END FUNCTION
```

---

## 💎 Hold-to-Maturity Logic

```pseudocode
FUNCTION checkHoldToMaturity(position, timeRemaining):
    
    // Only trigger when:
    // - Less than 45 seconds remaining
    // - Deep in-the-money (bid > $0.94)
    
    IF timeRemaining >= 45:
        RETURN FALSE  // Too early
    ENDIF
    
    orderBook = getOrderBook(position.tokenId)
    currentBid = orderBook.bestBid
    
    IF currentBid <= 0.94:
        RETURN FALSE  // Not deep enough ITM
    ENDIF
    
    // Cancel pending sell to hold for $1.00 settlement
    pendingSell = findPendingSellForPosition(position)
    
    IF pendingSell != NULL:
        LOG("💎 HOLD TO MATURITY: " + timeRemaining + "s left, Bid: $" + currentBid)
        cancelOrder(pendingSell.orderId)
        pendingSell.status = "CANCELLED"
        // Position will settle at $1.00 if it wins
        RETURN TRUE
    ENDIF
    
    RETURN FALSE
    
END FUNCTION
```

---

## 🚫 Kill Zone Logic

```pseudocode
FUNCTION isInKillZone(upAsk, upBid, downAsk, downBid):
    
    // Kill Zone: $0.40 - $0.60 (Maximum Uncertainty)
    // This is where probability is ~50/50 and risk is highest
    
    KILL_ZONE_LOW = 0.40
    KILL_ZONE_HIGH = 0.60
    
    // Check if UP token is in kill zone
    upMid = (upAsk + upBid) / 2
    IF upMid >= KILL_ZONE_LOW AND upMid <= KILL_ZONE_HIGH:
        LOG("⚠️ KILL ZONE: UP token at $" + upMid)
        RETURN TRUE
    ENDIF
    
    // Check if DOWN token is in kill zone
    downMid = (downAsk + downBid) / 2
    IF downMid >= KILL_ZONE_LOW AND downMid <= KILL_ZONE_HIGH:
        LOG("⚠️ KILL ZONE: DOWN token at $" + downMid)
        RETURN TRUE
    ENDIF
    
    RETURN FALSE
    
END FUNCTION
```

---

## 🔄 Market Rotation

```pseudocode
FUNCTION handleMarketRotation(newMarketInfo):
    
    // 1. Emergency exit any open positions
    position = getPaperPosition()
    IF position != NULL:
        LOG("Emergency exit for market rotation")
        orderBook = getOrderBook(position.tokenId)
        exitPrice = orderBook.bestBid > 0 ? orderBook.bestBid : 0.50
        executeFAK(position.tokenId, "SELL", exitPrice, position.shares)
    ENDIF
    
    // 2. Save session data
    saveSessionData()
    saveTradeData()
    
    // 3. Reset strategy state
    activePositions.CLEAR()
    tradeRecords.CLEAR()
    clearAllOrders()
    
    // 4. Reset peak bankroll to current cash
    peakBankroll = getCurrentCash()
    
    // 5. Start new session
    startNewSession(newMarketInfo.slug)
    
END FUNCTION
```

---

## 📊 Statistics Calculation

```pseudocode
FUNCTION getStats():
    
    records = getAllTradeRecords()
    
    buyOrders = FILTER(records, r => r.side == "BUY")
    sellOrders = FILTER(records, r => r.side == "SELL")
    
    executedBuys = FILTER(buyOrders, r => r.status == "FILLED")
    executedSells = FILTER(sellOrders, r => r.status == "FILLED")
    
    // Count by exit type
    stopLossExits = COUNT(sellOrders WHERE status=="FILLED" AND exitType=="STOP_LOSS")
    limitSellFills = COUNT(sellOrders WHERE status=="FILLED" AND exitType=="LIMIT")
    cancelledSells = COUNT(sellOrders WHERE status=="CANCELLED")
    
    // Calculate totals
    totalInvested = SUM(buy.price * buy.size FOR buy IN executedBuys)
    totalProceeds = SUM(sell.price * sell.size FOR sell IN executedSells)
    
    // Calculate realized PNL (completed trades)
    realizedPNL = 0
    FOR EACH buy IN executedBuys:
        pairedSell = FIND(sellOrders WHERE pairedWith==buy.id AND status=="FILLED")
        IF pairedSell != NULL:
            buyCost = buy.price * buy.size
            sellProceeds = pairedSell.price * pairedSell.size
            realizedPNL += (sellProceeds - buyCost)
        ENDIF
    END FOR
    
    // Count naked positions (bought but no filled sell)
    nakedPositions = FILTER(executedBuys, buy => 
        NOT EXISTS(sellOrders WHERE pairedWith==buy.id AND status=="FILLED")
    )
    
    RETURN {
        totalBuyOrders: buyOrders.length,
        executedBuyOrders: executedBuys.length,
        stopLossExits,
        limitSellFills,
        cancelledSells,
        nakedPositions: nakedPositions.length,
        totalInvested,
        totalProceeds,
        realizedPNL,
        netPNL: totalProceeds - totalInvested
    }
    
END FUNCTION
```

---

## 🔧 Configuration Parameters

```pseudocode
CONFIG = {
    // Timing
    TICK_INTERVAL: 500,              // Main loop interval (ms)
    STOP_LOSS_CHECK_INTERVAL: 150,   // Stop-loss monitor interval (ms)
    MARKET_ROTATION_THRESHOLD: 5,    // Minutes before expiry to rotate
    
    // Trading
    TRADE_SIZE_PERCENT: 0.10,        // 10% of peak bankroll
    PROFIT_TARGET: 0.02,             // $0.02 per trade
    REQUIRED_EDGE: 0.05,             // 5¢ edge required
    MIN_TRADE_SIZE: 1.00,            // Minimum $1.00 trade
    MIN_PROBABILITY: 0.60,           // 60% minimum fair value
    
    // Risk Management
    STOP_LOSS_THRESHOLD: 0.10,       // 10¢ stop-loss
    STOP_LOSS_SLIPPAGE_CAP: 0.02,    // Max 2¢ slippage on stop-loss
    MAX_SPREAD: 0.03,                // Max $0.03 spread
    
    // Kill Zone
    KILL_ZONE_LOW: 0.40,
    KILL_ZONE_HIGH: 0.60,
    
    // Hold to Maturity
    HTM_TIME_THRESHOLD: 45,          // Seconds before expiry
    HTM_PRICE_THRESHOLD: 0.94,       // Deep ITM threshold
    
    // Paper Trading
    STARTING_CAPITAL: 20.00
}
```

---

## 📝 Trade Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRADE LIFECYCLE                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. ENTRY CHECK                                                     │
│     ├── Time > 150s remaining?                                      │
│     ├── No pending trades?                                          │
│     ├── Price history available?                                    │
│     ├── Fair Value >= 60%?                                          │
│     └── Market Price < (Fair Value - 5¢)?                           │
│                                                                     │
│  2. PRE-TRADE VALIDATION                                            │
│     ├── Spread <= 3¢?                                               │
│     ├── Not in Kill Zone ($0.40-$0.60)?                             │
│     └── Sufficient cash?                                            │
│                                                                     │
│  3. EXECUTION                                                       │
│     ├── BUY: FOK order (10% of peak bankroll)                       │
│     └── SELL: GTC limit order (Entry + 2¢)                          │
│                                                                     │
│  4. ACTIVE MONITORING (Every 150ms)                                 │
│     └── Check Stop-Loss: Bid < (Entry - 10¢)?                       │
│                                                                     │
│  5. EXIT PATHS                                                      │
│     ├── A) LIMIT FILL: Sell order fills at Entry + 2¢               │
│     ├── B) STOP-LOSS: Emergency sell at threshold - 2¢ max slip     │
│     └── C) HOLD-TO-MATURITY: Cancel sell if <45s & Bid > $0.94      │
│                                                                     │
│  6. SETTLEMENT                                                      │
│     └── Token settles at $1.00 or $0.00 at expiration               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

*Last Updated: December 22, 2024*

