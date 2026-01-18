# 🎯 Expiration Convergence Strategy Documentation

## Overview

This bot trades **BTC 15-minute Up/Down binary options** on Polymarket. It exploits the mathematical certainty that as expiration approaches, token prices must converge to either $0.00 (loss) or $1.00 (win).

```
                    EXPIRATION
    $0.50 ─────────────┬───────────────> $1.00 (WIN)
         \            │
          \           │
           \          │
            ──────────┴───────────────> $0.00 (LOSS)
    
    ◄─────── TIME ────────►
    High Uncertainty    Certainty
```

---

## 🧠 Core Strategy Logic

### The Edge: Fair Value vs Market Price

The bot calculates a **theoretical fair value** using the Quant Engine:
- Current BTC spot price vs strike price
- Time remaining until expiration
- Real-time volatility (measured in $/minute)
- Z-Score probability calculation

**Trade Signal:** Buy when `Market Price < Fair Value - 5¢ edge`

### Example

```
BTC Spot:    $95,000
Strike:      $94,900
Difference:  +$100 (BTC above strike → UP is winning)

Volatility:  $15/min
Time Left:   5 minutes
Z-Score:     1.33 → 91% probability UP wins

Fair Value:  $0.91
Market Ask:  $0.82
Edge:        $0.09 (> $0.05 required)

→ BUY UP @ $0.82
→ SELL @ $0.84 (entry + $0.02 profit target)
```

---

## ✅ Entry Conditions (ALL must be TRUE)

| # | Condition | Threshold | Reason |
|---|-----------|-----------|--------|
| 1 | Time Remaining | > 150 seconds | Avoid end-game chaos |
| 2 | Fair Value Edge | > $0.05 | Minimum edge to trade |
| 3 | Not in Kill Zone | Price NOT in $0.40-$0.60 | Maximum uncertainty zone |
| 4 | Spread Acceptable | < $0.10 | Avoid illiquid markets |
| 5 | No Pending Trades | Previous sell must fill | One trade at a time |
| 6 | Sufficient Capital | > $1.00 available | Minimum trade size |

---

## 🚪 Exit Strategies

### 1. 🎯 Limit Sell (Target: +$0.02)
- Placed immediately after buy
- Captures quick profits on price convergence
- Most common exit (profitable trades)

### 2. 🛑 Stop-Loss (Threshold: Entry - $0.10)
- **High-frequency monitoring** (every 150ms)
- Triggers when bid falls below threshold
- **Slippage capped** at 2¢ below threshold
- Minimizes losses on bad trades

### 3. 💎 Hold to Maturity
- If < 45 seconds remaining AND price > $0.94
- Cancel limit sell, hold for $1.00 settlement
- Captures remaining 6¢+ value

---

## 💰 Position Sizing

```
Trade Amount = min(Peak Bankroll × 10%, Available Cash)
```

| Starting Capital | Trade Size |
|-----------------|------------|
| $20.00 | $2.00 |
| $22.00 (after wins) | $2.20 |
| $18.00 (after losses) | $1.80 |

**Compounding:** Peak bankroll updates after each profitable cycle.

---

## 🛡️ Risk Management

### Per-Trade Limits
| Risk | Limit |
|------|-------|
| Position Size | 10% of peak bankroll |
| Stop-Loss | Entry - $0.10 (configurable) |
| Max Slippage | 2¢ past stop threshold |
| Max Loss/Trade | ~15% of position |

### Kill Zone Avoidance
```
$0.40 ─────────────────────── $0.60
      ← KILL ZONE: NO TRADES →
```
Prices in this range = 50/50 coin flip. Bot refuses to trade.

---

## 🔄 Trade Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│  1. SIGNAL DETECTED                                         │
│     Fair Value > Market Price + 5¢                          │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  2. BUY EXECUTED (FOK)                                      │
│     $2.00 @ $0.62 = 3.23 shares                             │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  3. SELL ORDER PLACED (GTC)                                 │
│     3.23 shares @ $0.64 (entry + $0.02)                     │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
          ┌───────────┴───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│  SELL FILLS      │    │  STOP-LOSS       │
│  @ $0.64         │    │  @ $0.52         │
│  P&L: +$0.06     │    │  P&L: -$0.32     │
│  ROI: +3.23%     │    │  ROI: -16%       │
└──────────────────┘    └──────────────────┘
```

---

## ⚙️ Configuration

### Environment Variables (.env)

```bash
# Mode
PAPER_TRADE=true

# Capital
MAX_CAPITAL_PER_TRADE=20.00

# Risk
STOP_LOSS_THRESHOLD=0.10   # Stop-loss distance from entry
MAX_SPREAD=0.10            # Maximum acceptable spread

# Execution
SNIPE_CUSHION=0.02         # Buy above best ask
DUMP_CUSHION=0.02          # Sell below best bid

# Timing
TICK_INTERVAL=500          # Main loop interval (ms)
```

### Key Parameters in Code

| Parameter | Value | Location |
|-----------|-------|----------|
| Position Size | 10% of peak | `simpleArbitrageStrategy.ts` |
| Profit Target | +$0.02 | `simpleArbitrageStrategy.ts` |
| Stop-Loss Check | 150ms | `simpleArbitrageStrategy.ts` |
| Kill Zone | $0.40-$0.60 | `ExpirationConvergenceStrategy.ts` |
| Hold-to-Maturity | < 45s, > $0.94 | Both strategies |

---

## 📊 Logging & Output

### Log Files
Located in `./logs/` directory:
- `trades_{market}_{timestamp}.log` - Human-readable log
- `trades_{market}_{timestamp}.json` - Machine-readable data

### JSON Output Structure

```json
{
  "session": {
    "startTime": "2025-12-22T12:00:00.000Z",
    "endTime": "2025-12-22T12:15:00.000Z",
    "duration": 900,
    "marketSlug": "btc-updown-15m-1766404800"
  },
  "wallet": {
    "startingCapital": 20.00,
    "endingCapital": 19.50,
    "netChange": -0.50,
    "netChangePercent": -2.50,
    "profitable": false
  },
  "statistics": {
    "totalBuyOrders": 15,
    "executedBuyOrders": 15,
    "exits": {
      "limitSells": 12,
      "stopLosses": 3,
      "cancelled": 3,
      "total": 15
    },
    "nakedPositions": 0
  },
  "financial": {
    "totalInvested": 28.50,
    "totalProceeds": 28.00,
    "realizedPNL": -0.50,
    "netPNL": -0.50,
    "roi": -1.75
  },
  "trades": [...],
  "completedTrades": [...]
}
```

### Trade Record Fields

| Field | Description |
|-------|-------------|
| `id` | Unique trade ID (trade_0, trade_1, etc.) |
| `side` | BUY or SELL |
| `price` | Execution price |
| `size` | Number of shares |
| `amount` | Dollar amount (price × size) |
| `status` | PENDING, FILLED, or CANCELLED |
| `exitType` | LIMIT, STOP_LOSS, or HOLD_TO_MATURITY |
| `pairedWith` | ID of paired order (sell → buy) |

---

## 📈 Expected Performance

### Win Rate Breakdown

| Exit Type | Expected % | Avg P&L |
|-----------|-----------|---------|
| Limit Sell | ~70% | +$0.05 |
| Stop-Loss | ~25% | -$0.25 |
| Hold to Maturity | ~5% | +$0.10 |

### Per-Market Session (15 min)

| Metric | Conservative | Aggressive |
|--------|--------------|------------|
| Trades | 10-20 | 20-40 |
| Win Rate | 70% | 65% |
| Net P&L | +$0.50 | +$0.30 |
| ROI | +2.5% | +1.5% |

---

## 🚀 Running the Bot

```bash
# Development
npm run dev

# Production
npm start

# or directly
ts-node src/main.ts
```

The bot will:
1. ✅ Discover active 15-minute BTC markets
2. ✅ Calculate fair values using Quant Engine
3. ✅ Execute trades when edge conditions are met
4. ✅ Monitor stop-loss at high frequency (150ms)
5. ✅ Log everything to `./logs/` directory
6. ✅ Auto-rotate to next market at expiry
7. ✅ Display wallet summary on session end

---

## 📁 Project Structure

```
src/
├── main.ts                          # Main bot loop
├── config.ts                        # Configuration
├── execution.ts                     # Order execution
├── slugOracle.ts                    # Market discovery
├── strategies/
│   ├── simpleArbitrageStrategy.ts   # Main strategy (with HF stop-loss)
│   └── ExpirationConvergenceStrategy.ts
└── services/
    ├── tradeLogger.ts               # Logging & JSON export
    ├── orderBookService.ts          # Order book fetching
    ├── spotPriceService.ts          # BTC price feed
    └── quantEngine.ts               # Fair value calculation
```

---

## 🔧 Recent Updates

- ✅ **High-Frequency Stop-Loss** (150ms monitoring)
- ✅ **Slippage Cap** (max 2¢ below threshold)
- ✅ **Wallet Tracking** (starting/ending capital in JSON)
- ✅ **Exit Type Labels** (LIMIT, STOP_LOSS, HOLD_TO_MATURITY)
- ✅ **Configurable Stop-Loss** via `STOP_LOSS_THRESHOLD`
- ✅ **Clear Stats** (separate limit/stop-loss/cancelled counts)
