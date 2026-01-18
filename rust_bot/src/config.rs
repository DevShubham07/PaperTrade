/// Configuration management with environment variable loading
use anyhow::{Context, Result};
use rust_decimal::Decimal;
use std::env;
use std::str::FromStr;

/// Main bot configuration
#[derive(Debug, Clone)]
pub struct BotConfig {
    // Master switch
    pub paper_trade: bool,

    // Authentication (live mode only)
    pub signer_private_key: String,
    pub proxy_address: String,
    pub polygon_rpc_url: String,

    // Market discovery
    pub auto_discover_markets: bool,
    pub market_rotation_threshold: i64, // seconds

    // Strategy parameters (populated by market discovery)
    pub token_id_up: String,
    pub token_id_down: String,
    pub strike_price: Decimal,

    // Capital management
    pub max_capital_per_trade: Decimal,

    // Quant settings
    pub panic_discount: Decimal,
    pub scalp_profit: Decimal,
    pub stop_loss_threshold: Decimal,
    pub max_spread: Decimal,

    // Execution settings
    pub snipe_cushion: Decimal,
    pub dump_cushion: Decimal,
    pub snipe_wait_time: u64, // milliseconds

    // Timing
    pub market_expiry_timestamp: i64, // Unix milliseconds
    pub tick_interval: u64,           // milliseconds
}

impl BotConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        dotenv::dotenv().ok(); // Load .env file if present

        let config = Self {
            // Master switch
            paper_trade: get_env_bool("PAPER_TRADE", true),

            // Authentication
            signer_private_key: env::var("SIGNER_PRIVATE_KEY")
                .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string()),
            proxy_address: env::var("PROXY_ADDRESS")
                .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".to_string()),
            polygon_rpc_url: env::var("POLYGON_RPC_URL")
                .unwrap_or_else(|_| "https://polygon-rpc.com".to_string()),

            // Market discovery
            auto_discover_markets: get_env_bool("AUTO_DISCOVER_MARKETS", true),
            market_rotation_threshold: get_env_i64("MARKET_ROTATION_THRESHOLD", 30),

            // Strategy parameters
            token_id_up: env::var("TOKEN_ID_UP").unwrap_or_default(),
            token_id_down: env::var("TOKEN_ID_DOWN").unwrap_or_default(),
            strike_price: get_env_decimal("STRIKE_PRICE", Decimal::ZERO),

            // Capital management
            max_capital_per_trade: get_env_decimal("MAX_CAPITAL_PER_TRADE", Decimal::from(20)),

            // Quant settings
            panic_discount: get_env_decimal("PANIC_DISCOUNT", Decimal::from_str("0.08").unwrap()),
            scalp_profit: get_env_decimal("SCALP_PROFIT", Decimal::from_str("0.01").unwrap()),
            stop_loss_threshold: get_env_decimal("STOP_LOSS_THRESHOLD", Decimal::from_str("0.10").unwrap()),
            max_spread: get_env_decimal("MAX_SPREAD", Decimal::from_str("0.50").unwrap()),

            // Execution
            snipe_cushion: get_env_decimal("SNIPE_CUSHION", Decimal::from_str("0.02").unwrap()),
            dump_cushion: get_env_decimal("DUMP_CUSHION", Decimal::from_str("0.02").unwrap()),
            snipe_wait_time: get_env_u64("SNIPE_WAIT_TIME", 2000),

            // Timing
            market_expiry_timestamp: get_env_i64(
                "MARKET_EXPIRY_TIMESTAMP",
                chrono::Utc::now().timestamp_millis() + 15 * 60 * 1000,
            ),
            tick_interval: get_env_u64("TICK_INTERVAL", 500),
        };

        config.validate()?;
        Ok(config)
    }

    /// Validate configuration values
    fn validate(&self) -> Result<()> {
        let mut errors = Vec::new();

        // Validate live mode requirements
        if !self.paper_trade {
            if self.signer_private_key == "0x0000000000000000000000000000000000000000000000000000000000000000" {
                errors.push("SIGNER_PRIVATE_KEY is required for live trading");
            }
            if self.proxy_address == "0x0000000000000000000000000000000000000000" {
                errors.push("PROXY_ADDRESS is required for live trading");
            }
        }

        // Validate manual market mode requirements
        if !self.auto_discover_markets {
            if self.token_id_up.is_empty() {
                errors.push("TOKEN_ID_UP must be set when AUTO_DISCOVER_MARKETS is disabled");
            }
            if self.token_id_down.is_empty() {
                errors.push("TOKEN_ID_DOWN must be set when AUTO_DISCOVER_MARKETS is disabled");
            }
            if self.strike_price <= Decimal::ZERO {
                errors.push("STRIKE_PRICE must be positive when AUTO_DISCOVER_MARKETS is disabled");
            }
        }

        // Validate numeric ranges
        if self.max_capital_per_trade <= Decimal::ZERO {
            errors.push("MAX_CAPITAL_PER_TRADE must be positive");
        }
        if self.panic_discount < Decimal::ZERO || self.panic_discount > Decimal::ONE {
            errors.push("PANIC_DISCOUNT must be between 0 and 1");
        }
        if self.scalp_profit < Decimal::ZERO || self.scalp_profit > Decimal::ONE {
            errors.push("SCALP_PROFIT must be between 0 and 1");
        }
        if self.stop_loss_threshold < Decimal::ZERO || self.stop_loss_threshold > Decimal::ONE {
            errors.push("STOP_LOSS_THRESHOLD must be between 0 and 1");
        }
        if self.market_rotation_threshold < 10 || self.market_rotation_threshold > 300 {
            errors.push("MARKET_ROTATION_THRESHOLD must be between 10 and 300 seconds");
        }

        if !errors.is_empty() {
            anyhow::bail!("Configuration validation failed:\n{}", errors.join("\n"));
        }

        Ok(())
    }

    /// Update market configuration dynamically (for auto-discovery)
    pub fn update_market(
        &mut self,
        up_token_id: String,
        down_token_id: String,
        strike_price: Decimal,
        expiry_timestamp: i64,
    ) {
        self.token_id_up = up_token_id;
        self.token_id_down = down_token_id;
        self.strike_price = strike_price;
        self.market_expiry_timestamp = expiry_timestamp;
    }

    /// Print configuration summary
    pub fn print_summary(&self) {
        println!("✅ Configuration loaded successfully");
        println!(
            "📊 Mode: {}",
            if self.paper_trade {
                "PAPER TRADING"
            } else {
                "⚠️ LIVE TRADING"
            }
        );
        println!(
            "🔄 Market Discovery: {}",
            if self.auto_discover_markets {
                "AUTO"
            } else {
                "MANUAL"
            }
        );
        if !self.auto_discover_markets {
            println!("🎯 Strike Price: ${:.2}", self.strike_price);
        }
        println!("💰 Max Capital: ${:.2}", self.max_capital_per_trade);
    }
}

// Helper functions for parsing environment variables

fn get_env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(default)
}

fn get_env_i64(key: &str, default: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn get_env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn get_env_decimal(key: &str, default: Decimal) -> Decimal {
    env::var(key)
        .ok()
        .and_then(|v| Decimal::from_str(&v).ok())
        .unwrap_or(default)
}
