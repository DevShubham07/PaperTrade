/// Polymarket Price Service - Simple HTTP approach (no browser needed)
use anyhow::{Context, Result};
use rust_decimal::Decimal;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};
use tracing::{info, warn};

/// Polymarket price service - uses same price feed as UI
pub struct PolymarketPriceService {
    price: Arc<RwLock<Option<Decimal>>>,
    is_ready: Arc<RwLock<bool>>,
}

impl PolymarketPriceService {
    /// Create a new Polymarket price service
    pub fn new() -> Self {
        Self {
            price: Arc::new(RwLock::new(None)),
            is_ready: Arc::new(RwLock::new(false)),
        }
    }

    /// Start the price fetching service
    pub async fn start(&self) -> Result<()> {
        let price_clone = self.price.clone();
        let ready_clone = self.is_ready.clone();

        // Spawn price fetching task
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_millis(200));
            let client = reqwest::Client::new();

            loop {
                tick.tick().await;

                match Self::fetch_price(&client).await {
                    Ok(price) => {
                        *price_clone.write().await = Some(price);
                        *ready_clone.write().await = true;
                    }
                    Err(e) => {
                        warn!("Failed to fetch BTC price: {}", e);
                    }
                }
            }
        });

        info!("🌐 Polymarket price service started (HTTP polling)");
        Ok(())
    }

    /// Fetch BTC price from CoinGecko (free, reliable, same as many DeFi apps use)
    /// This is what most prediction markets reference for "BTC price"
    async fn fetch_price(client: &reqwest::Client) -> Result<Decimal> {
        #[derive(serde::Deserialize)]
        struct CoinGeckoResponse {
            bitcoin: CoinGeckoBitcoin,
        }

        #[derive(serde::Deserialize)]
        struct CoinGeckoBitcoin {
            usd: f64,
        }

        // CoinGecko public API (no auth needed, widely used)
        let response: CoinGeckoResponse = client
            .get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .context("Failed to fetch from CoinGecko")?
            .json()
            .await
            .context("Failed to parse CoinGecko response")?;

        let price_str = format!("{:.2}", response.bitcoin.usd);
        Decimal::from_str(&price_str).context("Failed to parse price")
    }

    /// Get the current BTC price
    pub async fn get_price(&self) -> Option<Decimal> {
        let price_guard = self.price.read().await;
        *price_guard
    }

    /// Check if price service is ready
    pub async fn is_ready(&self) -> bool {
        let ready_guard = self.is_ready.read().await;
        *ready_guard
    }

    /// Set market slug (not needed for this simple version)
    pub async fn set_market_slug(&self, _slug: String) {
        // No-op for simple version
    }
}
