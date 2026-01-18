/// Trading service with paper and live modes using polyfill-rs
use anyhow::{Context, Result};
use polyfill_rs::{ClobClient, Side as ClobSide, OrderArgs};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::config::BotConfig;
use crate::models::{Order, OrderSide, Position};

/// Trading service supporting both paper and live trading
pub struct TradingService {
    config: BotConfig,
    clob_client: Option<ClobClient>,

    // Paper trading state
    paper_cash: Arc<RwLock<Decimal>>,
    paper_position: Arc<RwLock<Option<Position>>>,
    paper_orders: Arc<RwLock<HashMap<String, Order>>>,
    paper_order_counter: Arc<RwLock<u64>>,
}

impl TradingService {
    /// Create a new trading service
    pub fn new(config: BotConfig) -> Result<Self> {
        let clob_client = if !config.paper_trade {
            // Initialize live CLOB client with L1 headers (signatures)
            // Uses optimized HTTP/2 connection for internet connectivity
            let client = ClobClient::with_l1_headers(
                "https://clob.polymarket.com",
                &config.signer_private_key,
                137, // Polygon Mainnet chain ID
            );

            // Note: In production, you'd want to derive API credentials:
            // let api_creds = client.create_or_derive_api_key(None).await?;
            // client.set_api_creds(api_creds);

            Some(client)
        } else {
            None
        };

        info!("⚡ Trading Service initialized");
        info!(
            "💼 Mode: {}",
            if config.paper_trade { "PAPER" } else { "LIVE" }
        );

        if config.paper_trade {
            info!("💵 Paper Cash: $100.00");
        }

        Ok(Self {
            config,
            clob_client,
            paper_cash: Arc::new(RwLock::new(Decimal::from(100))),
            paper_position: Arc::new(RwLock::new(None)),
            paper_orders: Arc::new(RwLock::new(HashMap::new())),
            paper_order_counter: Arc::new(RwLock::new(0)),
        })
    }

    /// Place a BUY order
    pub async fn buy(&self, token_id: &str, price: Decimal, size: Decimal) -> Result<String> {
        self.place_limit_order(token_id, OrderSide::BUY, price, size)
            .await
    }

    /// Place a SELL order
    pub async fn sell(&self, token_id: &str, price: Decimal, size: Decimal) -> Result<String> {
        self.place_limit_order(token_id, OrderSide::SELL, price, size)
            .await
    }

    /// Place a limit order (GTC)
    async fn place_limit_order(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<String> {
        if self.config.paper_trade {
            self.place_paper_order(token_id, side, price, size).await
        } else {
            self.place_live_order(token_id, side, price, size).await
        }
    }

    /// Cancel an order
    pub async fn cancel_order(&self, order_id: &str) -> Result<()> {
        if self.config.paper_trade {
            self.cancel_paper_order(order_id).await
        } else {
            self.cancel_live_order(order_id).await
        }
    }

    /// Execute immediate market order
    pub async fn execute_market_order(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<bool> {
        if self.config.paper_trade {
            self.execute_paper_fak(token_id, side, price, size).await
        } else {
            self.execute_live_fak(token_id, side, price, size).await
        }
    }

    /// Get current position
    pub async fn get_position(&self) -> Option<Position> {
        self.paper_position.read().await.clone()
    }

    /// Get cash balance
    pub async fn get_cash_balance(&self) -> Decimal {
        *self.paper_cash.read().await
    }

    /// Check if we have a position
    pub async fn has_position(&self) -> bool {
        self.paper_position.read().await.is_some()
    }

    /// Check paper fills based on current market prices
    pub async fn check_paper_fills(
        &self,
        token_id: &str,
        best_ask: Decimal,
        best_bid: Decimal,
    ) -> Option<Position> {
        let mut orders = self.paper_orders.write().await;
        let mut filled_order_id: Option<String> = None;

        for (order_id, order) in orders.iter() {
            if order.token_id != token_id {
                continue;
            }

            let mut filled = false;

            if order.side == OrderSide::BUY && best_ask <= order.price {
                // Buy order filled - market came down to our price
                filled = true;
                let cost = order.price * order.size;
                let mut cash = self.paper_cash.write().await;
                *cash -= cost;

                let position = Position {
                    token_id: order.token_id.clone(),
                    shares: order.size,
                    entry_price: order.price,
                    entry_time: chrono::Utc::now().timestamp_millis(),
                };

                *self.paper_position.write().await = Some(position.clone());

                info!(
                    "[PAPER] 🔔 BUY ORDER FILLED @ {:.4}. Cash: ${:.2}",
                    order.price, *cash
                );
            } else if order.side == OrderSide::SELL && best_bid >= order.price {
                // Sell order filled - market came up to our price
                filled = true;
                let proceeds = order.price * order.size;
                let mut cash = self.paper_cash.write().await;
                *cash += proceeds;

                if let Some(pos) = self.paper_position.read().await.as_ref() {
                    let pnl = pos.calculate_pnl(order.price);
                    info!(
                        "[PAPER] 🔔 SELL ORDER FILLED @ {:.4}. P&L: ${:.2}. Cash: ${:.2}",
                        order.price, pnl, *cash
                    );
                }

                *self.paper_position.write().await = None;
            }

            if filled {
                filled_order_id = Some(order_id.clone());
                break;
            }
        }

        if let Some(id) = filled_order_id {
            orders.remove(&id);
            return self.paper_position.read().await.clone();
        }

        None
    }

    // ==========================================
    // PAPER TRADING METHODS
    // ==========================================

    async fn place_paper_order(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<String> {
        let mut counter = self.paper_order_counter.write().await;
        let order_id = format!("PAPER_{}", *counter);
        *counter += 1;

        let order = Order {
            id: order_id.clone(),
            token_id: token_id.to_string(),
            side,
            price,
            size,
            timestamp: chrono::Utc::now().timestamp_millis(),
        };

        self.paper_orders.write().await.insert(order_id.clone(), order);

        info!(
            "[PAPER] 📝 {:?} LIMIT @ {:.4} | Token: {}... | Size: {}",
            side,
            price,
            &token_id[..8.min(token_id.len())],
            size
        );

        Ok(order_id)
    }

    async fn cancel_paper_order(&self, order_id: &str) -> Result<()> {
        let mut orders = self.paper_orders.write().await;
        if orders.remove(order_id).is_some() {
            info!("[PAPER] 🗑️ Cancelled Order {}", order_id);
            Ok(())
        } else {
            warn!("[PAPER] ⚠️ Order {} not found", order_id);
            anyhow::bail!("Order not found")
        }
    }

    async fn execute_paper_fak(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<bool> {
        info!(
            "[PAPER] 💥 MARKET ORDER: {:?} @ {:.4} | Token: {}... | Size: {}",
            side,
            price,
            &token_id[..8.min(token_id.len())],
            size
        );

        match side {
            OrderSide::BUY => {
                let cost = price * size;
                let mut cash = self.paper_cash.write().await;

                if *cash >= cost {
                    *cash -= cost;

                    let position = Position {
                        token_id: token_id.to_string(),
                        shares: size,
                        entry_price: price,
                        entry_time: chrono::Utc::now().timestamp_millis(),
                    };

                    *self.paper_position.write().await = Some(position);

                    info!(
                        "[PAPER] ✅ BOUGHT {} shares @ {:.4}. Cash: ${:.2}",
                        size, price, *cash
                    );
                    Ok(true)
                } else {
                    error!(
                        "[PAPER] ❌ Insufficient cash. Need ${:.2}, have ${:.2}",
                        cost, *cash
                    );
                    Ok(false)
                }
            }
            OrderSide::SELL => {
                let position_guard = self.paper_position.read().await;
                if let Some(pos) = position_guard.as_ref() {
                    if pos.shares >= size && pos.token_id == token_id {
                        let proceeds = price * size;
                        let entry_price = pos.entry_price;
                        drop(position_guard); // Release read lock

                        let pnl = (price - entry_price) * size;

                        let mut cash = self.paper_cash.write().await;
                        *cash += proceeds;

                        info!(
                            "[PAPER] ✅ SOLD {} shares @ {:.4}. P&L: ${:.2}. Cash: ${:.2}",
                            size, price, pnl, *cash
                        );

                        *self.paper_position.write().await = None;
                        Ok(true)
                    } else {
                        error!("[PAPER] ❌ No position to sell or wrong token");
                        Ok(false)
                    }
                } else {
                    error!("[PAPER] ❌ No position to sell");
                    Ok(false)
                }
            }
        }
    }

    // ==========================================
    // LIVE TRADING METHODS (using polyfill-rs)
    // ==========================================

    async fn place_live_order(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<String> {
        info!(
            "[LIVE] 💸 {:?} LIMIT @ {:.4} | Token: {}...",
            side,
            price,
            &token_id[..8.min(token_id.len())]
        );

        let client = self.clob_client.as_ref()
            .context("CLOB client not initialized")?;

        // Convert side to polyfill-rs Side
        let clob_side = match side {
            OrderSide::BUY => ClobSide::BUY,
            OrderSide::SELL => ClobSide::SELL,
        };

        // Create order using polyfill-rs OrderArgs
        let order_args = OrderArgs::new(
            token_id,
            price,
            size,
            clob_side,
        );

        // Submit order - polyfill-rs handles EIP-712 signing automatically
        let result = client.create_and_post_order(&order_args).await?;

        info!("[LIVE] ✅ Order placed");
        Ok("live_order_id".to_string())
    }

    async fn cancel_live_order(&self, order_id: &str) -> Result<()> {
        info!("[LIVE] 📡 Cancelling order {}", order_id);

        let client = self.clob_client.as_ref()
            .context("CLOB client not initialized")?;

        client.cancel_orders(&[order_id.to_string()]).await?;

        info!("[LIVE] ✅ Order cancelled");
        Ok(())
    }

    async fn execute_live_fak(
        &self,
        token_id: &str,
        side: OrderSide,
        price: Decimal,
        size: Decimal,
    ) -> Result<bool> {
        info!(
            "[LIVE] 💥 MARKET ORDER: {:?} @ {:.4} | Token: {}...",
            side,
            price,
            &token_id[..8.min(token_id.len())]
        );

        // For immediate execution, we just place a regular order
        // The aggressive price will ensure immediate fill
        let _order_id = self.place_live_order(token_id, side, price, size).await?;

        info!("[LIVE] ✅ Market order executed");
        Ok(true)
    }

    /// Fetch order book from Polymarket using polyfill-rs
    pub async fn fetch_order_book(&self, token_id: &str) -> Result<(Option<Decimal>, Option<Decimal>)> {
        if let Some(client) = self.clob_client.as_ref() {
            let book = client.get_order_book(token_id).await?;

            // Extract best bid and ask
            let best_bid = book.bids.first().map(|level| level.price);
            let best_ask = book.asks.first().map(|level| level.price);

            Ok((best_bid, best_ask))
        } else {
            anyhow::bail!("CLOB client not available in paper trading mode")
        }
    }
}
