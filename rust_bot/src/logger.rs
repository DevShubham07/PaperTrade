/// Session logging and data persistence
use anyhow::Result;
use rust_decimal::Decimal;
use serde_json;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tracing::info;

use crate::models::{SessionSummary, TickData};

/// Session logger for recording tick data
pub struct SessionLogger {
    session_id: String,
    start_time: i64,
    ticks: Arc<RwLock<Vec<TickData>>>,
    markets_traded: Arc<RwLock<u64>>,
}

impl SessionLogger {
    /// Create a new session logger
    pub fn new() -> Self {
        let session_id = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let start_time = chrono::Utc::now().timestamp_millis();

        info!("📊 Session started: {}", session_id);

        Self {
            session_id,
            start_time,
            ticks: Arc::new(RwLock::new(Vec::new())),
            markets_traded: Arc::new(RwLock::new(0)),
        }
    }

    /// Log a tick
    pub async fn log_tick(&self, tick_data: TickData) {
        self.ticks.write().await.push(tick_data);
    }

    /// Increment markets traded counter
    pub async fn increment_markets_traded(&self) {
        *self.markets_traded.write().await += 1;
    }

    /// Flush session data to JSON file
    pub async fn flush(
        &self,
        total_pnl: Decimal,
        final_cash: Decimal,
    ) -> Result<()> {
        let end_time = chrono::Utc::now().timestamp_millis();
        let duration_seconds = (end_time - self.start_time) / 1000;
        let ticks = self.ticks.read().await.clone();
        let markets_traded = *self.markets_traded.read().await;

        let summary = SessionSummary {
            session_id: self.session_id.clone(),
            start_time: self.start_time,
            end_time,
            duration_seconds,
            total_ticks: ticks.len() as u64,
            markets_traded,
            total_pnl,
            final_cash,
            ticks,
        };

        // Serialize to JSON
        let json = serde_json::to_string_pretty(&summary)?;

        // Write to file
        let filename = format!("session_{}.json", self.session_id);
        let mut file = File::create(&filename).await?;
        file.write_all(json.as_bytes()).await?;

        info!("📄 Session data saved to: {}", filename);
        self.print_summary(&summary);

        Ok(())
    }

    /// Print session summary
    fn print_summary(&self, summary: &SessionSummary) {
        info!("📊 SESSION SUMMARY");
        info!("   Session ID: {}", summary.session_id);
        info!("   Duration: {}s", summary.duration_seconds);
        info!("   Total Ticks: {}", summary.total_ticks);
        info!("   Markets Traded: {}", summary.markets_traded);
        info!("   Total P&L: ${:.2}", summary.total_pnl);
        info!("   Final Cash: ${:.2}", summary.final_cash);
    }
}
