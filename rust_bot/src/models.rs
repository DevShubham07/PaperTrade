/// Core data structures for the Polymarket trading bot
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Trading side (BUY or SELL)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    BUY,
    SELL,
}

/// Order type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    GTC,  // Good-Till-Cancel
    FOK,  // Fill-Or-Kill
    IOC,  // Immediate-Or-Cancel
}

/// Represents an open order
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub token_id: String,
    pub side: OrderSide,
    pub price: Decimal,
    pub size: Decimal,
    pub timestamp: i64,
}

/// Represents an open position
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub token_id: String,
    pub shares: Decimal,
    pub entry_price: Decimal,
    pub entry_time: i64,
}

impl Position {
    /// Calculate P&L for this position at given exit price
    pub fn calculate_pnl(&self, exit_price: Decimal) -> Decimal {
        (exit_price - self.entry_price) * self.shares
    }
}

/// Order book data from Polymarket
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    pub timestamp: i64,
    pub market: String,
    pub bids: Vec<OrderBookLevel>,
    pub asks: Vec<OrderBookLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookLevel {
    pub price: String,
    pub size: String,
}

impl OrderBook {
    /// Get best bid price
    pub fn best_bid(&self) -> Option<Decimal> {
        self.bids.first()
            .and_then(|level| level.price.parse().ok())
    }

    /// Get best ask price
    pub fn best_ask(&self) -> Option<Decimal> {
        self.asks.first()
            .and_then(|level| level.price.parse().ok())
    }

    /// Calculate spread
    pub fn spread(&self) -> Option<Decimal> {
        match (self.best_ask(), self.best_bid()) {
            (Some(ask), Some(bid)) => Some(ask - bid),
            _ => None,
        }
    }
}

/// Market information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketInfo {
    pub slug: String,
    pub token_id_up: String,
    pub token_id_down: String,
    pub strike_price: Decimal,
    pub expiry_timestamp: i64,  // Unix milliseconds
}

impl MarketInfo {
    /// Calculate minutes remaining until expiry
    pub fn minutes_remaining(&self) -> f64 {
        let now = chrono::Utc::now().timestamp_millis();
        let remaining_ms = self.expiry_timestamp - now;
        remaining_ms as f64 / 60_000.0
    }

    /// Check if market is expiring soon
    pub fn is_expiring_soon(&self, threshold_seconds: i64) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        let remaining_ms = self.expiry_timestamp - now;
        remaining_ms < (threshold_seconds * 1000)
    }
}

/// Gamma API market response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaMarket {
    #[serde(rename = "conditionId")]
    pub condition_id: String,
    #[serde(rename = "questionID")]
    pub question_id: String,
    pub question: String,
    #[serde(rename = "slug")]
    pub market_slug: String,
    #[serde(rename = "endDate")]
    pub end_date_iso: String,
    #[serde(rename = "eventStartTime")]
    pub game_start_time: String,
    #[serde(rename = "clobTokenIds", deserialize_with = "deserialize_clob_token_ids")]
    pub clob_token_ids: Vec<String>,
    #[serde(rename = "acceptingOrders")]
    pub accepting_orders: bool,
    pub closed: bool,
    pub active: bool,
}

/// Custom deserializer for clob_token_ids (handles both string and array formats)
fn deserialize_clob_token_ids<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Deserialize};
    use serde_json::Value;

    let value = Value::deserialize(deserializer)?;

    match value {
        // If it's already an array, use it directly
        Value::Array(arr) => {
            arr.into_iter()
                .map(|v| v.as_str().ok_or_else(|| de::Error::custom("Expected string in array")).map(String::from))
                .collect()
        },
        // If it's a string, parse it as JSON
        Value::String(s) => {
            serde_json::from_str(&s).map_err(de::Error::custom)
        },
        _ => Err(de::Error::custom("Expected array or string for clob_token_ids"))
    }
}

/// Crypto-price API response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CryptoPriceResponse {
    pub open_price: Option<f64>,  // API returns number, not string
    pub close_price: Option<f64>,
    pub timestamp: Option<i64>,
    pub completed: Option<bool>,
}

/// Session tick data for logging
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TickData {
    pub timestamp: i64,
    pub tick_number: u64,
    pub market_slug: String,
    pub spot_price: Decimal,
    pub strike_price: Decimal,
    pub fair_value: Decimal,
    pub target_buy_price: Decimal,
    pub best_bid: Option<Decimal>,
    pub best_ask: Option<Decimal>,
    pub spread: Option<Decimal>,
    pub minutes_remaining: f64,
    pub state: String,
}

/// Session summary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_seconds: i64,
    pub total_ticks: u64,
    pub markets_traded: u64,
    pub total_pnl: Decimal,
    pub final_cash: Decimal,
    pub ticks: Vec<TickData>,
}

/// Bot state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotState {
    Scanning,        // Looking for entry
    InPosition,      // Holding position
    ExitingProfit,   // Taking profit
    ExitingStopLoss, // Stop loss triggered
    Rotating,        // Market rotation in progress
}

impl std::fmt::Display for BotState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BotState::Scanning => write!(f, "SCANNING"),
            BotState::InPosition => write!(f, "IN_POSITION"),
            BotState::ExitingProfit => write!(f, "EXITING_PROFIT"),
            BotState::ExitingStopLoss => write!(f, "EXITING_STOP_LOSS"),
            BotState::Rotating => write!(f, "ROTATING"),
        }
    }
}
