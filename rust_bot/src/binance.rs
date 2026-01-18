/// Binance WebSocket client for real-time BTC/USDT price streaming
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{Duration, interval};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

const BINANCE_WS_URL: &str = "wss://stream.binance.com:9443/ws/btcusdt@trade";
const BINANCE_REST_URL: &str = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const REST_FALLBACK_INTERVAL_SECS: u64 = 5;

/// Binance trade stream message
#[derive(Debug, Deserialize)]
struct BinanceTradeMessage {
    #[serde(rename = "p")]
    price: String,
}

/// Binance REST API response
#[derive(Debug, Deserialize)]
struct BinancePriceResponse {
    price: String,
}

/// Binance price service with WebSocket + REST fallback
pub struct BinanceService {
    price: Arc<RwLock<Option<Decimal>>>,
    is_ready: Arc<RwLock<bool>>,
}

impl BinanceService {
    /// Create a new Binance service
    pub fn new() -> Self {
        Self {
            price: Arc::new(RwLock::new(None)),
            is_ready: Arc::new(RwLock::new(false)),
        }
    }

    /// Start the WebSocket connection and REST fallback
    pub async fn start(&self) -> Result<()> {
        let price_clone = self.price.clone();
        let ready_clone = self.is_ready.clone();

        // Spawn WebSocket task
        let ws_price = price_clone.clone();
        let ws_ready = ready_clone.clone();
        tokio::spawn(async move {
            loop {
                match Self::websocket_task(ws_price.clone(), ws_ready.clone()).await {
                    Ok(_) => {
                        info!("WebSocket connection closed, reconnecting in 5s...");
                    }
                    Err(e) => {
                        error!("WebSocket error: {}. Reconnecting in 5s...", e);
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });

        // Spawn REST fallback task
        let rest_price = price_clone.clone();
        let rest_ready = ready_clone.clone();
        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(REST_FALLBACK_INTERVAL_SECS));
            loop {
                interval.tick().await;
                if let Err(e) = Self::rest_fallback_task(&rest_price, &rest_ready).await {
                    warn!("REST fallback failed: {}", e);
                }
            }
        });

        info!("🌐 Binance service started (WebSocket + REST fallback)");
        Ok(())
    }

    /// WebSocket task - connects and processes price updates
    async fn websocket_task(
        price: Arc<RwLock<Option<Decimal>>>,
        is_ready: Arc<RwLock<bool>>,
    ) -> Result<()> {
        info!("🔌 Connecting to Binance WebSocket: {}", BINANCE_WS_URL);

        let (ws_stream, _) = connect_async(BINANCE_WS_URL)
            .await
            .context("Failed to connect to Binance WebSocket")?;

        info!("✅ Connected to Binance WebSocket");

        let (mut _write, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(trade) = serde_json::from_str::<BinanceTradeMessage>(&text) {
                        if let Ok(btc_price) = Decimal::from_str(&trade.price) {
                            *price.write().await = Some(btc_price);
                            *is_ready.write().await = true;
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    warn!("WebSocket closed by server");
                    break;
                }
                Err(e) => {
                    error!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// REST fallback task - periodically fetches price via REST API
    async fn rest_fallback_task(
        price: &Arc<RwLock<Option<Decimal>>>,
        is_ready: &Arc<RwLock<bool>>,
    ) -> Result<()> {
        let client = reqwest::Client::new();
        let response: BinancePriceResponse = client
            .get(BINANCE_REST_URL)
            .send()
            .await
            .context("Failed to fetch Binance REST price")?
            .json()
            .await
            .context("Failed to parse Binance REST response")?;

        let btc_price = Decimal::from_str(&response.price)
            .context("Failed to parse price as decimal")?;

        *price.write().await = Some(btc_price);
        *is_ready.write().await = true;

        Ok(())
    }

    /// Get the current BTC spot price
    pub async fn get_price(&self) -> Option<Decimal> {
        *self.price.read().await
    }

    /// Check if the service has received at least one price update
    pub async fn is_ready(&self) -> bool {
        *self.is_ready.read().await
    }

    /// Wait until the service is ready (has received first price)
    pub async fn wait_until_ready(&self) {
        while !self.is_ready().await {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_binance_service() {
        let service = BinanceService::new();
        service.start().await.unwrap();

        // Wait for first price
        service.wait_until_ready().await;

        // Verify we got a price
        let price = service.get_price().await;
        assert!(price.is_some());
        println!("BTC Price: ${}", price.unwrap());
    }
}
