/// High-performance Polymarket trading bot in Rust using polyfill-rs
mod config;
mod logger;
mod models;
mod polymarket_price;
mod quant;
mod slug_oracle;
mod trading;
mod wallet;

use anyhow::Result;
use rust_decimal::Decimal;
use std::str::FromStr;
use std::sync::Arc;
use tokio::signal;
use tokio::time::{interval, Duration};
use tracing::{error, info, warn};

use config::BotConfig;
use logger::SessionLogger;
use models::{BotState, MarketInfo, TickData};
use polymarket_price::PolymarketPriceService;
use quant::QuantEngine;
use slug_oracle::SlugOracle;
use trading::TradingService;
use wallet::WalletService;

/// Main trading bot orchestrator
struct TradingBot {
    config: BotConfig,
    price_scraper: Arc<PolymarketPriceService>,
    slug_oracle: SlugOracle,
    trading: Arc<TradingService>,
    wallet: Option<WalletService>,
    logger: SessionLogger,

    // State
    current_market: Option<MarketInfo>,
    state: BotState,
    tick_count: u64,
    active_order_id: Option<String>,
    markets_traded: u64,
    total_pnl: Decimal,
}

impl TradingBot {
    /// Create a new trading bot
    async fn new(config: BotConfig) -> Result<Self> {
        // Initialize services
        let price_scraper = Arc::new(PolymarketPriceService::new());
        let slug_oracle = SlugOracle::new();
        let trading = Arc::new(TradingService::new(config.clone())?);
        let logger = SessionLogger::new();

        // Initialize wallet service for live mode
        let wallet = if !config.paper_trade {
            Some(WalletService::new(
                &config.polygon_rpc_url,
                &config.signer_private_key,
                &config.proxy_address,
            )?)
        } else {
            None
        };

        Ok(Self {
            config,
            price_scraper,
            slug_oracle,
            trading,
            wallet,
            logger,
            current_market: None,
            state: BotState::Scanning,
            tick_count: 0,
            active_order_id: None,
            markets_traded: 0,
            total_pnl: Decimal::ZERO,
        })
    }

    /// Start the bot
    async fn start(&mut self) -> Result<()> {
        info!("🚀 ========================================");
        info!("🚀   POLYMARKET VULTURE BOT (RUST)");
        info!("🚀 ========================================");

        // Print configuration
        self.config.print_summary();

        // Check wallet balances if live trading
        if let Some(wallet) = &self.wallet {
            wallet
                .validate_trading_balance(self.config.max_capital_per_trade)
                .await?;
        }

        // Start Polymarket price scraper
        self.price_scraper.start().await?;
        info!("⏳ Waiting for price scraper to initialize...");

        // Start main loop
        info!(
            "🚀 Starting bot... (Tick interval: {}ms)",
            self.config.tick_interval
        );

        // Set up signal handler for graceful shutdown
        let bot_running = Arc::new(tokio::sync::RwLock::new(true));
        let running_clone = bot_running.clone();

        tokio::spawn(async move {
            match signal::ctrl_c().await {
                Ok(()) => {
                    info!("🛑 Received shutdown signal...");
                    *running_clone.write().await = false;
                }
                Err(err) => {
                    error!("Unable to listen for shutdown signal: {}", err);
                }
            }
        });

        // Main trading loop
        let mut tick_interval = interval(Duration::from_millis(self.config.tick_interval));

        while *bot_running.read().await {
            tick_interval.tick().await;

            if let Err(e) = self.tick().await {
                error!("⚠️ Tick error: {}", e);
            }
        }

        // Shutdown
        info!("🛑 Shutting down...");
        self.shutdown().await?;

        Ok(())
    }

    /// Main tick loop
    async fn tick(&mut self) -> Result<()> {
        self.tick_count += 1;
        info!("--- ⏱️ TICK #{} ---", self.tick_count);

        // 1. Discover or validate current market
        if let Err(e) = self.ensure_active_market().await {
            warn!("⚠️ Market discovery failed: {}", e);
            return Ok(());
        }

        // 2. Check if market is expiring soon
        if self.current_market.as_ref().unwrap().is_expiring_soon(self.config.market_rotation_threshold) {
            info!("🏁 Market ending soon - rotating");
            self.rotate_market().await?;
            return Ok(());
        }

        // Clone all market data before any mutable borrows
        let (trading_token, market_slug, market_strike, minutes_remaining, fair_value, spot_price, token_id_up, token_id_down, token_direction_str) = {
            let market = self.current_market.as_ref().unwrap();

            // Get BTC spot price
            let spot_price = match self.price_scraper.get_price().await {
                Some(price) => price,
                None => {
                    warn!("⚠️ Polymarket price not available yet");
                    return Ok(());
                }
            };

            // Calculate trading direction and fair value
            let minutes_remaining = market.minutes_remaining();
            let (token_direction, fair_value, _) = QuantEngine::select_trading_direction(
                spot_price,
                market.strike_price,
                minutes_remaining,
            );

            let trading_token = if token_direction == "UP" {
                market.token_id_up.clone()
            } else {
                market.token_id_down.clone()
            };

            (
                trading_token,
                market.slug.clone(),
                market.strike_price,
                minutes_remaining,
                fair_value,
                spot_price,
                market.token_id_up.clone(),
                market.token_id_down.clone(),
                token_direction.to_string(),
            )
        };

        // 6. Get order books for both UP and DOWN tokens
        let (up_bid, up_ask) = if self.config.paper_trade {
            match self.fetch_order_book_http(&token_id_up).await {
                Ok((bid, ask)) => (bid, ask),
                Err(e) => {
                    warn!("⚠️ Failed to fetch UP order book: {}", e);
                    return Ok(());
                }
            }
        } else {
            match self.trading.fetch_order_book(&token_id_up).await {
                Ok((bid, ask)) => (bid, ask),
                Err(e) => {
                    warn!("⚠️ Failed to fetch UP order book: {}", e);
                    return Ok(());
                }
            }
        };

        let (down_bid, down_ask) = if self.config.paper_trade {
            match self.fetch_order_book_http(&token_id_down).await {
                Ok((bid, ask)) => (bid, ask),
                Err(e) => {
                    warn!("⚠️ Failed to fetch DOWN order book: {}", e);
                    return Ok(());
                }
            }
        } else {
            match self.trading.fetch_order_book(&token_id_down).await {
                Ok((bid, ask)) => (bid, ask),
                Err(e) => {
                    warn!("⚠️ Failed to fetch DOWN order book: {}", e);
                    return Ok(());
                }
            }
        };

        if up_bid.is_none() || up_ask.is_none() || down_bid.is_none() || down_ask.is_none() {
            warn!("⚠️ Order book has no liquidity");
            return Ok(());
        }

        // Use the trading token's order book for execution
        let (best_bid, best_ask) = if token_direction_str == "UP" {
            (up_bid, up_ask)
        } else {
            (down_bid, down_ask)
        };

        let spread = best_ask.unwrap() - best_bid.unwrap();

        info!("📊 Spot: ${:.2} | Strike: ${:.2} | Direction: {}", spot_price, market_strike, token_direction_str);
        info!("🧮 Fair: {:.4}", fair_value);
        info!("📖 UP:   Bid {:.4} / Ask {:.4}", up_bid.unwrap(), up_ask.unwrap());
        info!("📖 DOWN: Bid {:.4} / Ask {:.4}", down_bid.unwrap(), down_ask.unwrap());
        info!("📊 Trading {} token (Spread: {:.4})", token_direction_str, spread);
        info!("⏰ Time Left: {:.1} minutes", minutes_remaining);

        // 6. Check spread validity
        if !QuantEngine::is_spread_acceptable(spread, self.config.max_spread) {
            warn!("⚠️ Spread too wide: {:.4}", spread);
            return Ok(());
        }

        // 7. Execute trading strategy
        self.execute_strategy(&trading_token, fair_value, best_bid.unwrap(), best_ask.unwrap())
            .await?;

        // 8. Check paper fills (paper mode only)
        if self.config.paper_trade {
            self.trading
                .check_paper_fills(&trading_token, best_ask.unwrap(), best_bid.unwrap())
                .await;
        }

        // 9. Log tick data
        let tick_data = TickData {
            timestamp: chrono::Utc::now().timestamp_millis(),
            tick_number: self.tick_count,
            market_slug,
            spot_price,
            strike_price: market_strike,
            fair_value,
            target_buy_price: QuantEngine::calculate_entry_price(
                fair_value,
                self.config.panic_discount,
            ),
            best_bid,
            best_ask,
            spread: Some(spread),
            minutes_remaining,
            state: self.state.to_string(),
        };

        self.logger.log_tick(tick_data).await;
        info!("🔍 STATE: {}", self.state);

        Ok(())
    }

    /// Fetch order book via HTTP (for paper trading mode)
    async fn fetch_order_book_http(&self, token_id: &str) -> Result<(Option<Decimal>, Option<Decimal>)> {
        use serde::Deserialize;

        #[derive(Deserialize)]
        struct OrderBookLevel {
            price: String,
        }

        #[derive(Deserialize)]
        struct OrderBook {
            bids: Vec<OrderBookLevel>,
            asks: Vec<OrderBookLevel>,
        }

        let url = format!("https://clob.polymarket.com/book?token_id={}", token_id);
        let client = reqwest::Client::new();
        let book: OrderBook = client.get(&url).send().await?.json().await?;

        let best_bid = book.bids.first()
            .and_then(|level| Decimal::from_str(&level.price).ok());
        let best_ask = book.asks.first()
            .and_then(|level| Decimal::from_str(&level.price).ok());

        Ok((best_bid, best_ask))
    }

    /// Ensure we have an active market
    async fn ensure_active_market(&mut self) -> Result<()> {
        if self.config.auto_discover_markets {
            // Check if we need to discover
            if self.current_market.is_none() {
                info!("🔍 No active market. Discovering...");
                let mut market = self.slug_oracle.discover_active_market().await?;

                // If strike price is the default (100000), use current BTC price
                if market.strike_price == Decimal::from_str("100000")? {
                    if let Some(spot_price) = self.price_scraper.get_price().await {
                        market.strike_price = spot_price;
                        info!("📍 Using current BTC price as strike: ${:.2}", spot_price);
                    }
                }

                self.current_market = Some(market.clone());
                self.markets_traded += 1;
                self.logger.increment_markets_traded().await;

                // Set the market slug for price scraper
                self.price_scraper.set_market_slug(market.slug.clone()).await;

                info!("🎯 ========================================");
                info!("🎯 MARKET #{}: {}", self.markets_traded, market.slug);
                info!("🎯 Strike: ${:.2}", market.strike_price);
                info!("🎯 ========================================");
            }
        }

        Ok(())
    }

    /// Rotate to next market
    async fn rotate_market(&mut self) -> Result<()> {
        // Close any open positions
        if self.trading.has_position().await {
            warn!("🚨 Closing position before market rotation...");
            if let Some(pos) = self.trading.get_position().await {
                // Execute emergency exit
                let exit_price = Decimal::from_str_exact("0.50")?; // Mid-market estimate
                self.trading
                    .execute_market_order(&pos.token_id, models::OrderSide::SELL, exit_price, pos.shares)
                    .await?;

                let pnl = pos.calculate_pnl(exit_price);
                self.total_pnl += pnl;
                info!("💸 Emergency exit P&L: ${:.2}", pnl);
            }
        }

        // Cancel any open orders
        if let Some(order_id) = &self.active_order_id {
            info!("🗑️ Cancelling open orders...");
            let _ = self.trading.cancel_order(order_id).await;
            self.active_order_id = None;
        }

        // Discover next market
        self.current_market = None;
        self.state = BotState::Scanning;

        Ok(())
    }

    /// Execute trading strategy
    async fn execute_strategy(
        &mut self,
        token_id: &str,
        fair_value: Decimal,
        best_bid: Decimal,
        best_ask: Decimal,
    ) -> Result<()> {
        match self.state {
            BotState::Scanning => {
                // Calculate entry target
                let target_buy = QuantEngine::calculate_entry_price(
                    fair_value,
                    self.config.panic_discount,
                );

                // Check if we should enter
                if best_ask <= target_buy {
                    let size = QuantEngine::calculate_position_size(
                        self.config.max_capital_per_trade,
                        best_ask,
                    );

                    info!("📤 Placing BUY order @ {:.4} (Size: {})", best_ask, size);

                    match self.trading.buy(token_id, best_ask, size).await {
                        Ok(order_id) => {
                            self.active_order_id = Some(order_id);
                            self.state = BotState::InPosition;
                        }
                        Err(e) => {
                            error!("❌ Order placement failed: {}", e);
                        }
                    }
                }
            }

            BotState::InPosition => {
                if let Some(pos) = self.trading.get_position().await {
                    let take_profit = QuantEngine::calculate_take_profit(
                        pos.entry_price,
                        self.config.scalp_profit,
                    );
                    let stop_loss = QuantEngine::calculate_stop_loss(
                        pos.entry_price,
                        self.config.stop_loss_threshold,
                    );

                    // Check take profit
                    if best_bid >= take_profit {
                        info!("💰 Take profit triggered @ {:.4}", best_bid);
                        self.trading
                            .sell(token_id, best_bid, pos.shares)
                            .await?;
                        self.state = BotState::Scanning;
                    }
                    // Check stop loss
                    else if best_bid <= stop_loss {
                        warn!("🛑 Stop loss triggered @ {:.4}", best_bid);
                        self.trading
                            .execute_market_order(token_id, models::OrderSide::SELL, best_bid, pos.shares)
                            .await?;
                        self.state = BotState::Scanning;
                    }
                }
            }

            _ => {}
        }

        Ok(())
    }

    /// Shutdown bot gracefully
    async fn shutdown(&mut self) -> Result<()> {
        info!("📊 Flushing session data...");

        let final_cash = self.trading.get_cash_balance().await;
        self.logger.flush(self.total_pnl, final_cash).await?;

        info!("✅ Shutdown complete");
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    // Load configuration
    let config = BotConfig::from_env()?;

    // Create and start bot
    let mut bot = TradingBot::new(config).await?;
    bot.start().await?;

    Ok(())
}
