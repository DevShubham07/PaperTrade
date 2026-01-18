/**
 * Configuration Module
 * The Master Switchboard - Keys, Toggles, Risk Parameters
 */

import { config } from 'dotenv';

// Load environment variables from .env file
config();

export interface BotConfig {
    // === 🟢 MASTER SWITCH ===
    PAPER_TRADE: boolean;

    // === 🧷 HEDGE ARB MODE (Paper Trading) ===
    // When enabled, bot will buy BOTH UP and DOWN at a fixed entry price (default 0.49)
    // and hold to settlement to realize ~+$0.02 per share pair (if fills at 0.49/0.49).
    HEDGE_ARBITRAGE_MODE: boolean;
    HEDGE_ENTRY_PRICE: number;

    // === 🔑 AUTHENTICATION (Live Mode Only) ===
    SIGNER_PRIVATE_KEY: string;
    PROXY_ADDRESS: string;
    POLYGON_RPC_URL: string;             // Polygon RPC endpoint
    CLOB_API_KEY?: string;                // Polymarket API key (optional, will be generated if missing)
    CLOB_SECRET?: string;                 // Polymarket API secret (optional, will be generated if missing)
    CLOB_PASSPHRASE?: string;            // Polymarket API passphrase (optional, will be generated if missing)

    // === 🔄 MARKET DISCOVERY ===
    AUTO_DISCOVER_MARKETS: boolean;      // Auto-find active 15m BTC markets
    MARKET_ROTATION_THRESHOLD: number;   // Seconds before expiry to rotate
    MANUAL_STRIKE_PRICE?: number;        // Override strike price (for when API fails)

    // === ⚙️ STRATEGY PARAMETERS ===
    // ⚠️ CRITICAL: Store BOTH Token IDs (UP and DOWN)
    TOKEN_ID_UP: string;
    TOKEN_ID_DOWN: string;
    STRIKE_PRICE: number;

    // === 💰 CAPITAL MANAGEMENT ===
    BANKROLL: number;                    // Total bankroll (default $20)
    TRADE_SIZE_PCT: number;              // Percentage of bankroll per trade (default 10%)
    MAX_CAPITAL_PER_TRADE: number;
    MIN_ORDER_SIZE: number;

    // === 🛡️ SENIOR QUANT v2.1 - SIMPLIFIED SCALPER ===
    MIN_ENTRY_PRICE: number;             // Safe zone floor ($0.65)
    MAX_ENTRY_PRICE: number;             // Safe zone ceiling ($0.85)
    MAX_ALLOWED_SPREAD: number;          // Reject if market is too thin
    
    // v2.1 FIXED RISK PARAMS
    FIXED_PROFIT_TARGET: number;         // Fixed profit target (e.g., $0.02 = 2 cents)
    FIXED_STOP_LOSS: number;             // Fixed stop loss (e.g., $0.04 = 4 cents)
    BREAKEVEN_TRIGGER: number;           // Move stop to entry after this profit (e.g., $0.015 = 1.5 cents)
    
    // Legacy params (kept for compatibility)
    BASE_RISK_PREMIUM: number;
    MAX_TOLERABLE_STOP: number;
    STOP_LOSS_SPREAD_MULTIPLIER: number;
    MIN_STOP_DISTANCE: number;
    
    // Circuit breaker
    STABILITY_TICKS_REQUIRED: number;
    MIN_COOLDOWN_MS: number;
    MIN_TRADE_INTERVAL_MS: number;

    // Session Management
    SESSION_PROFIT_TARGET: number;
    SESSION_LOSS_LIMIT: number;

    // Trend Confirmation (DISABLED in v2.1)
    TREND_LOOKBACK_TICKS: number;
    MIN_TREND_DELTA: number;

    // === 📊 QUANT SETTINGS (Legacy - kept for compatibility) ===
    PANIC_DISCOUNT: number;
    SCALP_PROFIT: number;
    STOP_LOSS_THRESHOLD: number;
    MAX_SPREAD: number;              // Maximum acceptable spread

    // === 🎯 CAPPED SNIPER EXECUTION ===
    SNIPE_CUSHION: number;           // How much above best ask to bid (e.g., 0.02 = 2 cents)
    DUMP_CUSHION: number;            // How much below best bid to offer when dumping (e.g., 0.02)
    SNIPE_WAIT_TIME: number;         // Milliseconds to wait before canceling unfilled snipe order

    // === ⏰ TIMING ===
    MARKET_EXPIRY_TIMESTAMP: number;
    TICK_INTERVAL: number;
}

// Load configuration from environment variables with fallback defaults
function loadConfig(): BotConfig {
    const hedgeMode = process.env.HEDGE_ARBITRAGE_MODE === 'true';
    return {
        // Master Switch
        PAPER_TRADE: process.env.PAPER_TRADE === 'true',

        // Hedge Arb Mode
        HEDGE_ARBITRAGE_MODE: process.env.HEDGE_ARBITRAGE_MODE === 'true',
        HEDGE_ENTRY_PRICE: parseFloat(process.env.HEDGE_ENTRY_PRICE || '0.49'),

        // Authentication
        SIGNER_PRIVATE_KEY: process.env.SIGNER_PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000',
        PROXY_ADDRESS: process.env.PROXY_ADDRESS || '0x0000000000000000000000000000000000000000',
        POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        CLOB_API_KEY: process.env.CLOB_API_KEY,
        CLOB_SECRET: process.env.CLOB_SECRET,
        CLOB_PASSPHRASE: process.env.CLOB_PASSPHRASE,

        // Market Discovery
        AUTO_DISCOVER_MARKETS: process.env.AUTO_DISCOVER_MARKETS !== 'false', // Default to true
        // Hedge mode should not rotate early; default to rotating only AFTER expiry (0 seconds)
        MARKET_ROTATION_THRESHOLD: parseInt(process.env.MARKET_ROTATION_THRESHOLD || (hedgeMode ? '0' : '30')),
        MANUAL_STRIKE_PRICE: process.env.MANUAL_STRIKE_PRICE ? parseFloat(process.env.MANUAL_STRIKE_PRICE) : undefined,

        // Strategy Parameters (will be populated by SlugOracle)
        TOKEN_ID_UP: process.env.TOKEN_ID_UP || '',
        TOKEN_ID_DOWN: process.env.TOKEN_ID_DOWN || '',
        STRIKE_PRICE: parseFloat(process.env.STRIKE_PRICE || '0'),

        // Capital Management
        BANKROLL: parseFloat(process.env.BANKROLL || '20.00'),
        TRADE_SIZE_PCT: parseFloat(process.env.TRADE_SIZE_PCT || '0.10'),
        MAX_CAPITAL_PER_TRADE: parseFloat(process.env.MAX_CAPITAL_PER_TRADE || '20.00'),
        MIN_ORDER_SIZE: parseFloat(process.env.MIN_ORDER_SIZE || '1.00'),

    // Senior Quant v2.1 - Simplified Scalper
    MIN_ENTRY_PRICE: parseFloat(process.env.MIN_ENTRY_PRICE || '0.65'),  // Safe zone floor
    MAX_ENTRY_PRICE: parseFloat(process.env.MAX_ENTRY_PRICE || '0.85'),  // Safe zone ceiling
    MAX_ALLOWED_SPREAD: parseFloat(process.env.MAX_ALLOWED_SPREAD || '0.03'),
    
    // v2.1 FIXED RISK PARAMS (no more dynamic calculations)
    FIXED_PROFIT_TARGET: parseFloat(process.env.FIXED_PROFIT_TARGET || '0.02'),  // Fixed 2¢ profit
    FIXED_STOP_LOSS: parseFloat(process.env.FIXED_STOP_LOSS || '0.04'),          // Fixed 4¢ stop
    BREAKEVEN_TRIGGER: parseFloat(process.env.BREAKEVEN_TRIGGER || '0.015'),     // Move to breakeven at +1.5¢
    
    // Legacy dynamic params (kept for compatibility, not used in v2.1)
    BASE_RISK_PREMIUM: parseFloat(process.env.BASE_RISK_PREMIUM || '0.02'),
    MAX_TOLERABLE_STOP: parseFloat(process.env.MAX_TOLERABLE_STOP || '0.10'),
    STOP_LOSS_SPREAD_MULTIPLIER: parseFloat(process.env.STOP_LOSS_SPREAD_MULTIPLIER || '2.5'),
    MIN_STOP_DISTANCE: parseFloat(process.env.MIN_STOP_DISTANCE || '0.05'),
    
    // Circuit breaker cooldown
    STABILITY_TICKS_REQUIRED: parseInt(process.env.STABILITY_TICKS_REQUIRED || '15'),
    MIN_COOLDOWN_MS: parseInt(process.env.MIN_COOLDOWN_MS || '15000'),  // 15 seconds minimum after stop-loss
    MIN_TRADE_INTERVAL_MS: parseInt(process.env.MIN_TRADE_INTERVAL_MS || '5000'),  // 5 seconds between trades

    // Session Management (Profit Locking)
    SESSION_PROFIT_TARGET: parseFloat(process.env.SESSION_PROFIT_TARGET || '0.50'),  // Stop after +$0.50 profit
    SESSION_LOSS_LIMIT: parseFloat(process.env.SESSION_LOSS_LIMIT || '0.40'),        // Stop after -$0.40 loss

    // Trend Confirmation - DISABLED in v2.1 (kept for compatibility)
    TREND_LOOKBACK_TICKS: parseInt(process.env.TREND_LOOKBACK_TICKS || '5'),
    MIN_TREND_DELTA: parseFloat(process.env.MIN_TREND_DELTA || '0.02'),

        // Quant Settings (Legacy)
        PANIC_DISCOUNT: parseFloat(process.env.PANIC_DISCOUNT || '0.08'),
        SCALP_PROFIT: parseFloat(process.env.SCALP_PROFIT || '0.01'),
        STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_THRESHOLD || '0.10'),
        MAX_SPREAD: parseFloat(process.env.MAX_SPREAD || '0.50'),

        // Capped Sniper Execution
        SNIPE_CUSHION: parseFloat(process.env.SNIPE_CUSHION || '0.02'),
        DUMP_CUSHION: parseFloat(process.env.DUMP_CUSHION || '0.02'),
        SNIPE_WAIT_TIME: parseInt(process.env.SNIPE_WAIT_TIME || '2000'),

        // Timing
        MARKET_EXPIRY_TIMESTAMP: parseInt(process.env.MARKET_EXPIRY_TIMESTAMP || String(Date.now() + 15 * 60 * 1000)),
        TICK_INTERVAL: parseInt(process.env.TICK_INTERVAL || '500')
    };
}

// Validate configuration
function validateConfig(config: BotConfig): void {
    const errors: string[] = [];

    // Validate required fields for live mode
    if (!config.PAPER_TRADE) {
        if (config.SIGNER_PRIVATE_KEY === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            errors.push('SIGNER_PRIVATE_KEY is required for live trading');
        }
        if (config.PROXY_ADDRESS === '0x0000000000000000000000000000000000000000') {
            errors.push('PROXY_ADDRESS is required for live trading');
        }
    }

    // Validate market parameters (only if not auto-discovering)
    if (!config.AUTO_DISCOVER_MARKETS) {
        if (!config.TOKEN_ID_UP || config.TOKEN_ID_UP === '') {
            errors.push('TOKEN_ID_UP must be set when AUTO_DISCOVER_MARKETS is disabled');
        }
        if (!config.TOKEN_ID_DOWN || config.TOKEN_ID_DOWN === '') {
            errors.push('TOKEN_ID_DOWN must be set when AUTO_DISCOVER_MARKETS is disabled');
        }
        if (config.STRIKE_PRICE <= 0) {
            errors.push('STRIKE_PRICE must be positive when AUTO_DISCOVER_MARKETS is disabled');
        }
    }

    // Validate numeric ranges
    if (config.MAX_CAPITAL_PER_TRADE <= 0) {
        errors.push('MAX_CAPITAL_PER_TRADE must be positive');
    }
    if (config.PANIC_DISCOUNT < 0 || config.PANIC_DISCOUNT > 1) {
        errors.push('PANIC_DISCOUNT must be between 0 and 1');
    }
    if (config.SCALP_PROFIT < 0 || config.SCALP_PROFIT > 1) {
        errors.push('SCALP_PROFIT must be between 0 and 1');
    }
    if (config.STOP_LOSS_THRESHOLD < 0 || config.STOP_LOSS_THRESHOLD > 1) {
        errors.push('STOP_LOSS_THRESHOLD must be between 0 and 1');
    }
    // Hedge mode needs to allow expiry (0) so we can hold to settlement.
    const minRotation = config.HEDGE_ARBITRAGE_MODE ? 0 : 10;
    if (config.MARKET_ROTATION_THRESHOLD < minRotation || config.MARKET_ROTATION_THRESHOLD > 300) {
        errors.push(`MARKET_ROTATION_THRESHOLD must be between ${minRotation} and 300 seconds`);
    }
    if (config.HEDGE_ARBITRAGE_MODE) {
        if (!config.PAPER_TRADE) {
            errors.push('HEDGE_ARBITRAGE_MODE is currently supported only in PAPER_TRADE mode');
        }
        if (!(config.HEDGE_ENTRY_PRICE > 0 && config.HEDGE_ENTRY_PRICE < 1)) {
            errors.push('HEDGE_ENTRY_PRICE must be between 0 and 1');
        }
    }

    if (errors.length > 0) {
        throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
}

// Export singleton instance
export const CONFIG = loadConfig();

// Helper function to update dynamic market parameters
export function updateMarketConfig(upTokenId: string, downTokenId: string, strikePrice: number, expiryTimestamp: number): void {
    CONFIG.TOKEN_ID_UP = upTokenId;
    CONFIG.TOKEN_ID_DOWN = downTokenId;
    CONFIG.STRIKE_PRICE = strikePrice;
    CONFIG.MARKET_EXPIRY_TIMESTAMP = expiryTimestamp;
}

// Validate on module load
try {
    validateConfig(CONFIG);
    console.log('✅ Configuration loaded successfully');
    console.log(`📊 Mode: ${CONFIG.PAPER_TRADE ? 'PAPER TRADING' : '⚠️ LIVE TRADING'}`);
    console.log(`🔄 Market Discovery: ${CONFIG.AUTO_DISCOVER_MARKETS ? 'AUTO' : 'MANUAL'}`);
    console.log(`🧷 Hedge Arb Mode: ${CONFIG.HEDGE_ARBITRAGE_MODE ? `ON (@ $${CONFIG.HEDGE_ENTRY_PRICE.toFixed(2)})` : 'OFF'}`);
    if (!CONFIG.AUTO_DISCOVER_MARKETS) {
        console.log(`🎯 Strike Price: $${CONFIG.STRIKE_PRICE.toFixed(2)}`);
    }
    console.log(`💰 Max Capital: $${CONFIG.MAX_CAPITAL_PER_TRADE.toFixed(2)}`);
} catch (error) {
    console.error('❌ Configuration Error:', error);
    process.exit(1);
}
