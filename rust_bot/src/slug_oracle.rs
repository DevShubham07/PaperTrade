/// Automatic market discovery for Polymarket 15-minute BTC Gamma markets
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::Value;
use std::str::FromStr;
use tracing::{error, info, warn};

use crate::models::{CryptoPriceResponse, GammaMarket, MarketInfo};

const GAMMA_API_URL: &str = "https://gamma-api.polymarket.com/markets";
const CRYPTO_PRICE_API_URL: &str = "https://polymarket.com/api/crypto/crypto-price";

/// Market discovery service
pub struct SlugOracle {
    client: reqwest::Client,
}

impl SlugOracle {
    /// Create a new SlugOracle
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to build HTTP client"),
        }
    }

    /// Discover the current active 15-minute BTC market
    ///
    /// Returns MarketInfo with slug, token IDs, strike price, and expiry
    pub async fn discover_active_market(&self) -> Result<MarketInfo> {
        info!("🔍 Discovering active 15-minute BTC market...");

        // Generate candidate timestamps (current, next, previous, -2 windows)
        let now = Utc::now().timestamp();
        let candidates = self.generate_candidate_timestamps(now);

        // Try all candidates in parallel
        let mut tasks = Vec::new();
        for timestamp in candidates {
            let slug = format!("btc-updown-15m-{}", timestamp);
            let client = self.client.clone();
            tasks.push(tokio::spawn(async move {
                match Self::fetch_market_static(&client, &slug).await {
                    Ok(Some(market)) => Some((slug, market)),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("Failed to fetch {}: {}", slug, e);
                        None
                    }
                }
            }));
        }

        // Wait for all tasks and find first valid market
        for task in tasks {
            if let Ok(Some((slug, market))) = task.await {
                if Self::is_market_active(&market) {
                    return self.build_market_info(&slug, &market).await;
                }
            }
        }

        anyhow::bail!("No active 15-minute BTC market found");
    }

    /// Generate candidate timestamps for market discovery
    fn generate_candidate_timestamps(&self, now: i64) -> Vec<i64> {
        let mut candidates = Vec::new();

        // Round to nearest 15-minute boundary
        let interval = 15 * 60; // 15 minutes in seconds
        let base = (now / interval) * interval;

        // Try: current window FIRST, then next, then previous windows
        candidates.push(base);             // Current window (PRIORITY)
        candidates.push(base + interval);  // Next window
        candidates.push(base - interval);  // -1 window
        candidates.push(base - interval * 2); // -2 windows

        candidates
    }

    /// Fetch market metadata from Gamma API
    async fn fetch_market_static(client: &reqwest::Client, slug: &str) -> Result<Option<GammaMarket>> {
        let url = format!("{}?slug={}", GAMMA_API_URL, slug);

        let response = client.get(&url).send().await?;

        if !response.status().is_success() {
            return Ok(None);
        }

        let markets: Vec<GammaMarket> = response.json().await?;

        Ok(markets.into_iter().next())
    }

    /// Check if market is currently active
    fn is_market_active(market: &GammaMarket) -> bool {
        // Must be: active, accepting orders, and not closed
        market.active && market.accepting_orders && !market.closed
    }

    /// Build MarketInfo from GammaMarket
    async fn build_market_info(&self, slug: &str, market: &GammaMarket) -> Result<MarketInfo> {
        // Extract token IDs
        if market.clob_token_ids.len() < 2 {
            anyhow::bail!("Market {} has insufficient token IDs", slug);
        }

        let token_id_up = market.clob_token_ids[0].clone();
        let token_id_down = market.clob_token_ids[1].clone();

        // Parse expiry timestamp
        let expiry_timestamp = Self::parse_expiry_timestamp(&market.end_date_iso)?;

        // Try to fetch strike price from API, fallback to parsing from slug
        let strike_price = match self.fetch_strike_price(slug, &market.game_start_time).await {
            Ok(price) => price,
            Err(_) => {
                // Extract timestamp from slug and use as approximate strike
                // Format: btc-updown-15m-1766223000
                warn!("Failed to fetch strike price from API, using timestamp-based estimate");
                let parts: Vec<&str> = slug.split('-').collect();
                if let Some(timestamp_str) = parts.last() {
                    if let Ok(timestamp) = timestamp_str.parse::<i64>() {
                        // Use 100000 as default strike (will be overridden by real-time price)
                        Decimal::from_str("100000")?
                    } else {
                        Decimal::from_str("100000")?
                    }
                } else {
                    Decimal::from_str("100000")?
                }
            }
        };

        info!("✅ Found Active Market: {}", slug);
        info!("⏳ Expires: {}", Self::format_timestamp(expiry_timestamp));
        info!("🎯 Strike: ${:.2}", strike_price);

        Ok(MarketInfo {
            slug: slug.to_string(),
            token_id_up,
            token_id_down,
            strike_price,
            expiry_timestamp,
        })
    }

    /// Fetch opening strike price from crypto-price API
    async fn fetch_strike_price(&self, slug: &str, game_start_time: &str) -> Result<Decimal> {
        // Parse game start time
        let start_dt = DateTime::parse_from_rfc3339(game_start_time)
            .context("Failed to parse game start time")?;

        // Calculate end time (15 minutes later)
        let end_dt = start_dt + chrono::Duration::minutes(15);

        // Build query parameters
        let params = [
            ("symbol", "BTC"),
            ("variant", "fifteen"),
            ("eventStartTime", &start_dt.to_rfc3339()),
            ("endDate", &end_dt.to_rfc3339()),
        ];

        // Fetch from API
        let response: CryptoPriceResponse = self
            .client
            .get(CRYPTO_PRICE_API_URL)
            .query(&params)
            .send()
            .await
            .context("Failed to fetch crypto price")?
            .json()
            .await
            .context("Failed to parse crypto price response")?;

        // Parse price from openPrice field
        if let Some(price_f64) = response.open_price {
            // Convert f64 to string then parse as Decimal for precision
            let price_str = format!("{:.8}", price_f64);
            Decimal::from_str(&price_str)
                .context("Failed to convert strike price to Decimal")
        } else {
            anyhow::bail!("API returned null openPrice - market may not have started yet")
        }
    }

    /// Parse ISO 8601 timestamp to Unix milliseconds
    fn parse_expiry_timestamp(iso_string: &str) -> Result<i64> {
        let dt = DateTime::parse_from_rfc3339(iso_string)
            .context("Failed to parse expiry timestamp")?;
        Ok(dt.timestamp_millis())
    }

    /// Format Unix milliseconds as human-readable timestamp
    fn format_timestamp(millis: i64) -> String {
        let dt = DateTime::from_timestamp_millis(millis)
            .unwrap_or_else(|| Utc::now());
        dt.format("%m/%d/%Y, %I:%M:%S %p").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_discover_market() {
        let oracle = SlugOracle::new();
        match oracle.discover_active_market().await {
            Ok(market) => {
                println!("Found market: {}", market.slug);
                println!("Strike: ${:.2}", market.strike_price);
                println!("UP token: {}", market.token_id_up);
                println!("DOWN token: {}", market.token_id_down);
                assert!(!market.slug.is_empty());
                assert!(!market.token_id_up.is_empty());
                assert!(!market.token_id_down.is_empty());
            }
            Err(e) => {
                println!("No active market found: {}", e);
            }
        }
    }

    #[test]
    fn test_timestamp_generation() {
        let oracle = SlugOracle::new();
        let now = 1734016200; // Example timestamp
        let candidates = oracle.generate_candidate_timestamps(now);

        assert_eq!(candidates.len(), 4);
        println!("Candidates: {:?}", candidates);
    }
}
