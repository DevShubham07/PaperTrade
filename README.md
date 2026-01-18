# Mean Reversion Vulture Bot

A sophisticated trading bot for Polymarket that implements a mean reversion strategy on Gamma markets (15-minute Bitcoin price prediction markets).

## Strategy Overview

The bot operates on the principle that short-term price dislocations in prediction markets represent opportunities for profit. It:

1. **Calculates Fair Value**: Uses real-time Bitcoin spot price and time remaining to compute what the YES token should theoretically be worth
2. **Hunts for Discounts**: Only enters positions when market price falls below fair value by a configured discount (default: 5 cents)
3. **Exits Methodically**: Closes positions with predefined take-profit (default: +3 cents) and stop-loss (default: -10 cents) targets

## Architecture

The bot is built with a modular architecture:

- **config.ts**: Configuration management with environment variable support
- **wallet.ts**: Wallet balance checking via Polygon RPC (MATIC & USDC)
- **slugOracle.ts**: Automatic discovery of active 15m BTC Gamma markets
- **oracle.ts**: Data fetching from Polymarket API and Binance WebSocket
- **binance.ts**: Real-time BTC price WebSocket connection
- **quant.ts**: Mathematical core for fair value calculations
- **execution.ts**: Order execution with paper trading simulation
- **main.ts**: Main strategy loop and state management

## Features

- **🔄 Automatic Market Rotation**: Discovers and seamlessly switches between 15m BTC markets
- **💳 Wallet Balance Monitoring**: Real-time MATIC and USDC balance checks via Polygon RPC
- **📊 Paper Trading Mode**: Test your strategy without risking real funds
- **⚡ Real-time Data**: Fast WebSocket connection to Binance for BTC price
- **💸 Gasless Trading**: Uses Polymarket's CLOB (Central Limit Order Book) for gasless order execution
- **🛡️ Risk Management**: Built-in stop-loss and take-profit mechanisms
- **🤝 Graceful Shutdown**: Handles SIGINT/SIGTERM for clean exits

## Installation

### Prerequisites

- Node.js 18+ and npm
- TypeScript knowledge
- A Polymarket account (for live trading)
- USDC on Polygon (for live trading)

### Setup

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Create your environment configuration:
```bash
cp .env.example .env
```

4. Edit `.env` with your settings:
```env
# === MASTER SWITCH ===
PAPER_TRADE=true  # Start with true to test!

# === AUTHENTICATION (for live trading) ===
SIGNER_PRIVATE_KEY=0x...  # Your EOA private key
PROXY_ADDRESS=0x...        # Your Polymarket proxy address

# === MARKET DISCOVERY (NEW!) ===
AUTO_DISCOVER_MARKETS=true  # Automatically find and rotate markets
MARKET_ROTATION_THRESHOLD=30  # Seconds before expiry to rotate

# === STRATEGY PARAMETERS (optional if auto-discover enabled) ===
MARKET_ID=0x...           # The YES token ID (only for manual mode)
STRIKE_PRICE=98500.00     # Bitcoin strike price (only for manual mode)
MARKET_EXPIRY_TIMESTAMP=1234567890000  # Unix timestamp (only for manual mode)

# === CAPITAL & RISK ===
MAX_CAPITAL_PER_TRADE=20.00
PANIC_DISCOUNT=0.05       # 5 cents below fair value
SCALP_PROFIT=0.03         # 3 cents profit target
STOP_LOSS_THRESHOLD=0.10  # 10 cents stop loss

# === TIMING ===
TICK_INTERVAL=2000        # Run loop every 2 seconds
```

## Usage

### Paper Trading (Recommended First)

1. Ensure `PAPER_TRADE=true` in your `.env`
2. Build the project:
```bash
npm run build
```

3. Run the bot:
```bash
npm start
```

Or use development mode with auto-reload:
```bash
npm run dev
```

The bot will:
- Display your wallet balances (MATIC and USDC) on startup
- Connect to Binance WebSocket for real-time BTC prices
- Calculate fair values based on your strike price
- Simulate order placements and fills
- Track paper profits/losses

**Note**: Even in paper mode, the bot checks your real Polygon wallet balance for informational purposes.

### Live Trading

**WARNING: Live trading involves real money. Test thoroughly in paper mode first!**

1. Set `PAPER_TRADE=false` in `.env`
2. Add your `SIGNER_PRIVATE_KEY` (the private key of your EOA wallet)
3. Add your `PROXY_ADDRESS` (found in your Polymarket profile)
4. Ensure you have USDC balance on Polygon in your Polymarket account
5. Build and run:
```bash
npm run build
npm start
```

The bot will now sign real transactions and submit them to Polymarket's order book.

## Automatic Market Rotation (Slug Seeker)

**NEW FEATURE**: The bot can now automatically discover and rotate between active 15-minute BTC Gamma markets!

### How It Works

Polymarket creates new 15m BTC markets continuously with the pattern: `btc-updown-15m-{UNIX_TIMESTAMP}`. The bot:

1. **Discovers Markets**: Queries the Polymarket Gamma API to find all active 15m BTC markets
2. **Selects Current**: Chooses the market expiring soonest (the "current" market)
3. **Monitors Expiry**: Tracks time remaining until market closes
4. **Rotates Seamlessly**: 30 seconds before expiry (configurable):
   - Closes any open positions (emergency market sell)
   - Cancels any pending orders
   - Discovers the next active market
   - Updates strike price and token IDs
   - Resumes trading on the new market

### Configuration

```env
# Enable automatic market discovery (default: true)
AUTO_DISCOVER_MARKETS=true

# How many seconds before expiry to rotate (default: 30)
MARKET_ROTATION_THRESHOLD=30
```

### Benefits

- **24/7 Operation**: Bot can run indefinitely across multiple markets
- **No Manual Updates**: Automatically adapts to new strike prices and token IDs
- **Seamless Transitions**: Handles market overlaps gracefully
- **Risk Protection**: Forces position closure before market resolution

### Manual Mode

If you prefer to trade a single specific market:

```env
AUTO_DISCOVER_MARKETS=false
MARKET_ID=0x...           # Manually specify token ID
STRIKE_PRICE=98500.00     # Manually specify strike
MARKET_EXPIRY_TIMESTAMP=1734016200000  # Manually specify expiry
```

The bot will trade only this market and stop when it expires.

### Example Output

When market rotation occurs:

```
🏁 ========================================
🏁 MARKET ENDING SOON - ROTATING
🏁 ========================================
🚨 Closing position before market rotation...
💸 Emergency exit P&L: $0.15
🗑️ Cancelling open orders...
🔄 Market cleared. Will discover next market...

🔍 No active market. Discovering...
✅ Found Active Market: btc-updown-15m-1734016800
⏳ Expires: 12/12/2025, 4:00:00 PM
🔄 Next Market: btc-updown-15m-1734017700
🕐 Starts: 12/12/2025, 3:55:00 PM

🎯 ========================================
🎯 MARKET #2: btc-updown-15m-1734016800
🎯 Strike: $98,750.00
🎯 Expires: 12/12/2025, 4:00:00 PM
🎯 ========================================
```

## Configuration Guide

### Finding Your Proxy Address

1. Go to Polymarket.com and connect your wallet
2. Open your profile
3. Look for "Proxy Wallet" or "Safe Address" - this is your `PROXY_ADDRESS`

### Finding Market ID (Manual Mode Only)

**Note**: Only needed if `AUTO_DISCOVER_MARKETS=false`

1. Navigate to the Gamma market you want to trade
2. Open browser developer tools (F12)
3. Look for API calls to `/book?token_id=...`
4. The token_id is your `MARKET_ID`

### Setting Market Expiry (Manual Mode Only)

**Note**: Only needed if `AUTO_DISCOVER_MARKETS=false`

Gamma markets typically expire at specific times. Convert the expiry time to Unix timestamp (in milliseconds):
```javascript
new Date('2025-12-12T15:30:00Z').getTime()
// Example: 1734016200000
```

## Strategy Parameters Explained

### PANIC_DISCOUNT
The discount you demand below fair value before entering. Higher values = more conservative entries.
- Default: 0.05 (5 cents)
- Range: 0.01-0.20 recommended

### SCALP_PROFIT
Your profit target above entry price. Lower values = faster exits.
- Default: 0.03 (3 cents)
- Range: 0.01-0.10 recommended

### STOP_LOSS_THRESHOLD
How much loss you'll tolerate before emergency exit. This is based on fair value, not market price.
- Default: 0.10 (10 cents)
- Range: 0.05-0.20 recommended

## Monitoring

The bot outputs detailed logs:

### Normal Trading
```
--- ⏱️ TICK #42 ---
📊 Spot: $98,530.00 | Strike: $98,500.00
🧮 Fair: 0.52 | Target Buy: 0.47
📖 Book: Bid 0.45 / Ask 0.48 (Spread: 0.03)
⏰ Time Left: 12.3 minutes
🔍 STATE: SCANNING
📤 Placing BUY order @ 0.47 (Size: 42)
```

### Market Rotation (Auto-Discover Mode)
```
🎯 ========================================
🎯 MARKET #1: btc-updown-15m-1734016800
🎯 Strike: $98,750.00
🎯 Expires: 12/12/2025, 4:00:00 PM
🎯 ========================================
```

### Session Summary
```
📊 SESSION SUMMARY
   Total Ticks: 450
   Markets Traded: 3
   Total P&L: $2.45
   Paper Cash: $102.45
```

## Safety Features

1. **Spread Check**: Refuses to trade if spread is too wide (>10 cents)
2. **Market Rotation**: Automatically closes positions before market expiry (auto-discover mode)
3. **Market Expiry Check**: Stops when market expires (manual mode)
4. **Stop Loss**: Emergency exit if position moves against you
5. **Graceful Shutdown**: Press Ctrl+C to cleanly exit with P&L summary

## Troubleshooting

### "Binance WebSocket not ready"
Wait 5-10 seconds for the connection to establish. The bot will retry automatically.

### "Configuration validation failed"
Check your `.env` file for missing or invalid values. All numeric values must be positive.

### "Order placement failed" (Live Mode)
- Verify your `SIGNER_PRIVATE_KEY` is correct
- Check your USDC balance on Polygon
- Ensure your `PROXY_ADDRESS` matches your Polymarket profile

## 🔐 Security

### Private Key Safety

**CRITICAL**: Never share your private key publicly or commit it to version control.

- ✅ Store private keys in `.env` (which is gitignored)
- ✅ Use hardware wallets for significant funds
- ✅ Create separate wallets for testing vs production
- ❌ Never share private keys in chat, email, or repositories
- ❌ Never commit `.env` to git

**⚠️ If you've exposed your private key, see [SECURITY_WARNING.md](./SECURITY_WARNING.md) for immediate actions.**

### Wallet Balance Monitoring

The bot displays your Polygon wallet balances on startup:
```
💰 ========================================
💰   WALLET BALANCES
💰 ========================================
📍 EOA Address:   0x3D0F...6E5
🔐 Proxy Address: 0x3D0F...6E5
⛽ MATIC Balance:  2.5000 MATIC
💵 USDC Balance:   $100.00 USDC
💰 ========================================
```

Before live trading, the bot automatically checks if you have sufficient USDC (≥ MAX_CAPITAL_PER_TRADE).

## Risk Warning

**This bot is for educational purposes. Trading involves substantial risk of loss.**

- Start with PAPER_TRADE mode
- Never risk more than you can afford to lose
- Monitor the bot actively during operation
- Understand that past performance does not guarantee future results
- Polymarket markets can be illiquid or unpredictable

## Development

### Project Structure
```
div_bot/
├── src/
│   ├── config.ts       # Configuration management
│   ├── wallet.ts       # Wallet balance checking
│   ├── slugOracle.ts   # Market discovery & rotation
│   ├── oracle.ts       # Data fetching from Polymarket
│   ├── binance.ts      # BTC price WebSocket
│   ├── quant.ts        # Fair value calculations
│   ├── execution.ts    # Order execution (paper/live)
│   └── main.ts         # Strategy loop & state machine
├── dist/               # Compiled JavaScript
├── .env                # Your configuration (⚠️ NEVER COMMIT)
├── .env.example        # Example configuration
├── SECURITY_WARNING.md # Security best practices
├── package.json
├── tsconfig.json
└── README.md
```

### Building
```bash
npm run build
```

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Watch Mode (continuous compilation)
```bash
npm run watch
```

## License

MIT

## Disclaimer

This software is provided "as is" without warranty of any kind. The authors are not responsible for any losses incurred through the use of this bot. Use at your own risk.
# PaperTrade
# PaperTrade
