/// Polymarket Price Scraper - Gets BTC price from Polymarket UI (same as app.py)
use anyhow::{Context, Result};
use headless_chrome::{Browser, LaunchOptions};
use regex::Regex;
use rust_decimal::Decimal;
use std::ffi::OsString;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{info, warn};

/// Polymarket price service - scrapes live price from UI
pub struct PolymarketPriceService {
    price: Arc<RwLock<Option<Decimal>>>,
    is_ready: Arc<RwLock<bool>>,
    current_market_slug: Arc<RwLock<Option<String>>>,
}

impl PolymarketPriceService {
    /// Create a new Polymarket price service
    pub fn new() -> Self {
        Self {
            price: Arc::new(RwLock::new(None)),
            is_ready: Arc::new(RwLock::new(false)),
            current_market_slug: Arc::new(RwLock::new(None)),
        }
    }

    /// Start the price scraping service
    pub async fn start(&self) -> Result<()> {
        let price_clone = self.price.clone();
        let ready_clone = self.is_ready.clone();
        let slug_clone = self.current_market_slug.clone();

        // Spawn scraping task
        tokio::task::spawn_blocking(move || {
            loop {
                // Get current market slug
                let slug = {
                    let slug_guard = tokio::runtime::Handle::current()
                        .block_on(slug_clone.read());
                    slug_guard.clone()
                };

                if let Some(market_slug) = slug {
                    match Self::scrape_price(&market_slug) {
                        Ok(price) => {
                            tokio::runtime::Handle::current().block_on(async {
                                *price_clone.write().await = Some(price);
                                *ready_clone.write().await = true;
                            });
                        }
                        Err(e) => {
                            warn!("Failed to scrape price: {}", e);
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(200));
            }
        });

        info!("🌐 Polymarket price scraper started (headless browser)");
        Ok(())
    }

    /// Scrape price from Polymarket UI (like app.py does)
    fn scrape_price(market_slug: &str) -> Result<Decimal> {
        // Launch headless Chrome (same as app.py: options.add_argument("--headless"))
        let browser = Browser::new(LaunchOptions {
            headless: true,
            ..Default::default()
        })
        .context("Failed to launch headless browser")?;

        let tab = browser.new_tab().context("Failed to create new tab")?;

        // Navigate to market page (same as app.py)
        let url = format!("https://polymarket.com/event/{}?tid={}", market_slug, chrono::Utc::now().timestamp_millis());
        tab.navigate_to(&url)
            .context("Failed to navigate to market page")?;

        // Wait for page to load (same as app.py: time.sleep(3))
        std::thread::sleep(Duration::from_secs(3));

        // Find the price element (number-flow-react tag) - same as app.py
        let element = tab
            .wait_for_element("number-flow-react")
            .context("Failed to find price element")?;

        // Try multiple methods to extract text (headless_chrome quirk)
        let text = element
            .get_inner_text()
            .or_else(|_| element.get_content())
            .or_else(|_| {
                // Fallback: try getting via JavaScript evaluation
                tab.evaluate("document.querySelector('number-flow-react').textContent.trim()", false)
                    .map(|val| val.value.map(|v| v.to_string()).unwrap_or_default())
            })
            .context("Failed to get price text from element")?
            .trim()
            .to_string();

        // Parse price with regex (matches $88,263.40 format - same as app.py)
        let price_regex = Regex::new(r"^\$\d{1,3}(,\d{3})*(\.\d+)?$")?;

        if price_regex.is_match(&text) {
            // Remove $ and commas, then parse
            let clean_text = text.replace("$", "").replace(",", "");
            let price = Decimal::from_str(&clean_text)
                .context("Failed to parse price as decimal")?;
            Ok(price)
        } else {
            anyhow::bail!("Price text doesn't match expected format: '{}' (empty or wrong format)", text)
        }
    }

    /// Update the market slug to scrape
    pub async fn set_market_slug(&self, slug: String) {
        let mut slug_guard = self.current_market_slug.write().await;
        *slug_guard = Some(slug);
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
}
