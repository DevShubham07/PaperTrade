# 🎯 Polymarket Expiration Convergence Strategy

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

The bot calculates a **theoretical fair value** using a quantitative model that answers: *"What's the probability this token settles at $1.00?"*

**Trade Signal:** Buy when `Market Price < Fair Value - 5¢ edge`

---

## 📐 Quant Engine: The Math

### Step 1: Volatility Calculation

The bot tracks BTC price changes over the last 60 ticks and calculates **volatility per minute**:

```
1. Collect price deltas: Δ₁, Δ₂, Δ₃, ... (changes between ticks)

2. Calculate Standard Deviation of deltas:
   σ_tick = √(Σ(Δᵢ - μ)² / n)

3. Scale to 1 minute using Square Root of Time:
   σ_minute = σ_tick × √(ticks_per_minute)

4. Floor at $5.00 (prevents overconfidence in flat markets)
```

**Example:**
```
Last 30 ticks show price changes: +$10, -$5, +$8, -$12, ...
Standard Deviation per tick: $15
Ticks per minute: 60 (if 1-second ticks)

Volatility = $15 × √60 = $116/minute
```

### Step 2: Z-Score Calculation

Z-Score measures: *"How many standard deviations away from losing are we?"*

```
Z = Distance / Expected Move

Where:
- Distance = Spot - Strike (for UP) or Strike - Spot (for DOWN)
- Expected Move = Volatility × √(Time in minutes)
```

**Example:**
```
BTC Spot:    $89,800
Strike:      $89,750
Direction:   UP
Distance:    $50 (above strike = winning)
Time Left:   400 seconds (6.67 minutes)
Volatility:  $30/minute

Expected Move = $30 × √6.67 = $77.46

Z-Score = $50 / $77.46 = 0.645
```

### Step 3: Probability from Z-Score

The Z-Score is converted to probability using the **Normal CDF** (Cumulative Distribution Function):

```
| Z-Score | Probability | Meaning |
|---------|-------------|---------|
| -2.0    | 2.3%        | Very likely to lose |
| -1.0    | 15.9%       | Likely to lose |
| 0.0     | 50.0%       | Coin flip |
| +1.0    | 84.1%       | Likely to win |
| +2.0    | 97.7%       | Very likely to win |
```

**Formula (Abramowitz & Stegun approximation):**
```
Φ(z) = 1 - (1/√2π) × e^(-z²/2) × (b₁t + b₂t² + b₃t³ + b₄t⁴ + b₅t⁵)

Where: t = 1/(1 + 0.2316419 × |z|)
```

### Step 4: Fair Value

**Fair Value = Probability** (as a price from $0.00 to $1.00)

```
Z-Score = 0.645
Probability = Φ(0.645) = 74.1%
Fair Value = $0.74
```

### Complete Example

```
BTC Spot:    $89,800
Strike:      $89,750
Direction:   UP (BTC is $50 above strike)
Time Left:   400 seconds (6.67 min)
Volatility:  $30/minute

Expected Move = $30 × √6.67 = $77.46
Z-Score = $50 / $77.46 = 0.645
Probability = Φ(0.645) = 74.1%

Fair Value:  $0.74
Market Ask:  $0.68
Required Edge: $0.05

Edge Check:  $0.68 < ($0.74 - $0.05) = $0.69 ✅
→ BUY UP @ $0.68
→ SELL @ $0.70 (entry + $0.02)
```

---

## 📊 Entry Conditions

All conditions must be TRUE to enter a trade:

| Condition | Rule | Why |
|-----------|------|-----|
| **Time Remaining** | > 150 seconds | Enough time for price to move |
| **Fair Value** | > 60% | Only trade high-probability setups |
| **Price Edge** | Market < (Fair - 5¢) | Ensures we're buying at a discount |
| **Spread Check** | Spread < 3¢ | Avoid illiquid markets |
| **Kill Zone** | Price NOT in $0.40-$0.60 | Maximum uncertainty zone |
| **No Pending Trades** | Previous trade must complete | One position at a time |

---

## 🎯 Exit Strategies

### 1. ✅ Limit Sell (Profit Target)

```
Buy @ $0.78 → Immediately place Sell @ $0.80 (+2¢)
```

- **Target:** Entry price + $0.02
- **Order Type:** GTC (Good-Til-Cancelled)
- **Expected ROI:** ~2.5% per trade

### 2. 🛑 Stop Loss (Loss Protection)

```
Entry: $0.78
Stop Loss Trigger: Bid < $0.68 (Entry - 10¢)
→ Emergency sell with slippage cap
```

- **Trigger:** Current bid drops 10¢ below entry (configurable via `STOP_LOSS_THRESHOLD`)
- **High-Frequency Monitor:** Checks every **150ms** (3x faster than main tick)
- **Slippage Cap:** Max 2¢ below threshold (exit at $0.66, not whatever the bid crashed to)
- **Action:** Cancel limit sell, execute protected sell
- **Purpose:** Prevent catastrophic losses with minimal slippage

### 3. 💎 Hold to Maturity (Maximum Profit)

```
Time Left: < 45 seconds
Current Bid: > $0.94 (deep in-the-money)
→ Cancel sell order, hold for $1.00 settlement
```

- **Trigger:** Deep ITM near expiration
- **Action:** Cancel limit sell, let position settle at $1.00
- **Benefit:** Captures extra 6¢+ vs selling at limit

---

## 💰 Position Sizing

### Formula

```
Trade Amount = 10% of Peak Bankroll
Position Size = Trade Amount / Buy Price
```

### Example

```
Initial Capital: $20.00
Peak Bankroll:   $20.50 (after profitable trades)
Trade Amount:    $2.05 (10% of peak)
Buy Price:       $0.78
Position Size:   2.63 shares
```

### Compounding

- Peak bankroll updates after each profitable cycle
- Losses don't reduce position size (uses peak, not current)
- Minimum trade: $1.00

---

## 🛡️ Risk Management

### Per-Trade Risk

| Metric | Value |
|--------|-------|
| Max Loss (Stop Loss) | ~10¢ per share |
| Position Size | 10% of capital |
| Max Loss per Trade | ~1% of total capital |

### Kill Zone Avoidance

```
$0.00 ──────────────────────────────────── $1.00
       │                              │
       │  🛑 KILL ZONE ($0.40-$0.60)  │
       │      Maximum Uncertainty      │
       │      50/50 Coin Flip         │
       └──────────────────────────────┘
```

The bot avoids trading when prices are in the $0.40-$0.60 range where:
- Probability is near 50%
- Any small BTC move can flip the outcome
- Risk/reward is unfavorable

---

## 📈 Trade Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│  1. SCAN                                                     │
│     • Monitor BTC spot price vs strike                       │
│     • Calculate fair value using volatility + Z-score        │
│     • Check all entry conditions                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. ENTRY                                                    │
│     • Place FOK (Fill-Or-Kill) buy order                    │
│     • Immediately place GTC sell @ entry + $0.02            │
│     • Lock trading until position closes                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. MONITOR                                                  │
│     • Check if limit sell fills (profit)                    │
│     • Check stop loss trigger (bid < entry - 10¢)           │
│     • Check hold-to-maturity (time < 45s, bid > $0.94)      │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────┐
       │  LIMIT   │    │  STOP    │    │  HOLD TO │
       │  FILL    │    │  LOSS    │    │ MATURITY │
       │  +2¢     │    │  -10¢    │    │  →$1.00  │
       └──────────┘    └──────────┘    └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. RESET                                                    │
│     • Update statistics                                      │
│     • Unlock trading                                         │
│     • Resume scanning for next opportunity                   │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Key Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `TICK_INTERVAL` | 500ms | How often to check market |
| `STOP_LOSS_CHECK` | 150ms | High-frequency stop-loss monitor |
| `PROFIT_TARGET` | +$0.02 | Limit sell offset |
| `STOP_LOSS_THRESHOLD` | $0.10 | Max loss before emergency exit (configurable) |
| `STOP_LOSS_SLIPPAGE_CAP` | $0.02 | Max slippage below stop threshold |
| `EDGE_REQUIRED` | $0.05 | Min discount vs fair value |
| `MIN_TIME` | 150s | Don't trade if less time left |
| `HOLD_TIME` | 45s | Consider hold-to-maturity below this |
| `HOLD_THRESHOLD` | $0.94 | Bid must be above this to hold |
| `KILL_ZONE_LOW` | $0.40 | Avoid trading above this |
| `KILL_ZONE_HIGH` | $0.60 | Avoid trading below this |
| `POSITION_SIZE` | 10% | Of peak bankroll |

---

## 📊 Expected Performance

### Per Trade (Ideal Conditions)

| Outcome | Probability | P&L | Expected Value |
|---------|-------------|-----|----------------|
| Limit Fill | ~70% | +$0.04 | +$0.028 |
| Stop Loss | ~20% | -$0.20 | -$0.040 |
| Hold to Maturity | ~10% | +$0.10 | +$0.010 |
| **Net Expected** | | | **-$0.002** |

### Reality Check

- Market efficiency reduces edge over time
- Volatility estimation errors affect fair value
- Slippage in fast-moving markets
- Paper trading ≠ live trading

---

## 🔄 Market Rotation

The bot automatically rotates to new markets:

1. **Discovery:** Find active BTC-UpDown-15m market
2. **Trading:** Execute strategy until market expires
3. **Settlement:** Wait for market to close
4. **Rotate:** Discover next active market
5. **Repeat**

---

## 📝 Logging & Monitoring

### Real-Time Stats

```
[STATS] Buys: 3/3 | Exits: [Limit: 2 | 🛑 StopLoss: 1 | ❌ Cancelled: 1] | Naked: 0
```

### Session Summary (JSON)

```json
{
  "wallet": {
    "startingCapital": 20.00,
    "endingCapital": 19.85,
    "netChange": -0.15,
    "netChangePercent": -0.75,
    "profitable": false
  },
  "statistics": {
    "executedBuyOrders": 3,
    "exits": {
      "limitSells": 2,
      "stopLosses": 1,
      "cancelled": 1
    }
  },
  "financial": {
    "totalInvested": 6.00,
    "totalProceeds": 5.85,
    "realizedPNL": -0.15,
    "roi": -2.5
  }
}
```

---

## ⚠️ Risks & Limitations

1. **Model Risk:** Fair value calculation may be inaccurate
2. **Execution Risk:** Orders may not fill at expected prices
3. **Liquidity Risk:** Wide spreads during volatility
4. **Platform Risk:** API failures, rate limits
5. **Market Risk:** Extreme BTC moves can hit stop loss frequently

---

## 🚀 Running the Bot

```bash
# Paper Trading (default)
npm start

# Configuration
# Edit src/config.ts for parameters
```

---

*Strategy Version: 1.2 | Last Updated: December 22, 2024*

---

## 🔧 Recent Updates (v1.1)

- ✅ **High-Frequency Stop-Loss Monitor** - Checks every 150ms (vs 500ms main tick)
- ✅ **Slippage Cap** - Max 2¢ below stop threshold prevents crash exits
- ✅ **Wallet Tracking** - Starting/ending capital in JSON output
- ✅ **Configurable Stop-Loss** - Set via `STOP_LOSS_THRESHOLD` in config
- ✅ **Exit Type Labels** - Trades marked as LIMIT, STOP_LOSS, or HOLD_TO_MATURITY
- ✅ **Clearer Stats** - Separate counts for limit fills, stop-losses, and cancellations

