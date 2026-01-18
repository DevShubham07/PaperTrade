/// Wallet balance checking via Polygon RPC
use anyhow::{Context, Result};
use ethers::prelude::*;
use rust_decimal::Decimal;
use std::str::FromStr;
use std::sync::Arc;
use tracing::{error, info};

const USDC_ADDRESS: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS: u32 = 6;

/// Wallet service for checking balances
pub struct WalletService {
    provider: Arc<Provider<Http>>,
    eoa_address: H160,
    proxy_address: H160,
}

impl WalletService {
    /// Create a new wallet service
    pub fn new(rpc_url: &str, signer_key: &str, proxy_address: &str) -> Result<Self> {
        let provider = Provider::<Http>::try_from(rpc_url)
            .context("Failed to connect to Polygon RPC")?;

        // Parse addresses
        let wallet = signer_key
            .parse::<LocalWallet>()
            .context("Failed to parse signer private key")?;
        let eoa_address = wallet.address();

        let proxy_address = proxy_address
            .parse::<H160>()
            .context("Failed to parse proxy address")?;

        Ok(Self {
            provider: Arc::new(provider),
            eoa_address,
            proxy_address,
        })
    }

    /// Check and display wallet balances
    pub async fn check_balances(&self) -> Result<(Decimal, Decimal)> {
        info!("💰 ========================================");
        info!("💰   WALLET BALANCES");
        info!("💰 ========================================");

        // Get MATIC balance
        let matic_balance = self.get_matic_balance().await?;

        // Get USDC balance
        let usdc_balance = self.get_usdc_balance().await?;

        info!("📍 EOA Address:   {:?}", self.eoa_address);
        info!("🔐 Proxy Address: {:?}", self.proxy_address);
        info!("⛽ MATIC Balance:  {:.4} MATIC", matic_balance);
        info!("💵 USDC Balance:   ${:.2} USDC", usdc_balance);
        info!("💰 ========================================");

        Ok((matic_balance, usdc_balance))
    }

    /// Get MATIC balance
    async fn get_matic_balance(&self) -> Result<Decimal> {
        let balance = self
            .provider
            .get_balance(self.proxy_address, None)
            .await
            .context("Failed to get MATIC balance")?;

        // Convert from wei to MATIC (18 decimals)
        let matic = Decimal::from_str(&balance.to_string())?
            / Decimal::from(1_000_000_000_000_000_000u64);

        Ok(matic)
    }

    /// Get USDC balance
    async fn get_usdc_balance(&self) -> Result<Decimal> {
        let usdc_address: H160 = USDC_ADDRESS.parse()?;

        // ERC20 balanceOf(address) function signature
        let data = {
            let mut bytes = vec![0x70, 0xa0, 0x82, 0x31]; // balanceOf selector
            bytes.extend_from_slice(&[0u8; 12]); // Padding
            bytes.extend_from_slice(self.proxy_address.as_bytes());
            bytes
        };

        let call = ethers::types::transaction::eip2718::TypedTransaction::Legacy(
            ethers::types::TransactionRequest {
                to: Some(ethers::types::NameOrAddress::Address(usdc_address)),
                data: Some(data.into()),
                ..Default::default()
            },
        );

        let result = self
            .provider
            .call(&call, None)
            .await
            .context("Failed to call USDC balanceOf")?;

        // Parse result as U256
        let balance = U256::from_big_endian(&result);

        // Convert from USDC (6 decimals)
        let usdc = Decimal::from_str(&balance.to_string())? / Decimal::from(1_000_000u64);

        Ok(usdc)
    }

    /// Validate sufficient balance for trading
    pub async fn validate_trading_balance(&self, min_usdc: Decimal) -> Result<bool> {
        let (_matic, usdc) = self.check_balances().await?;

        if usdc < min_usdc {
            error!(
                "❌ Insufficient USDC balance. Need ${:.2}, have ${:.2}",
                min_usdc, usdc
            );
            return Ok(false);
        }

        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires valid RPC and credentials
    async fn test_wallet_balances() {
        dotenv::dotenv().ok();

        let rpc_url = std::env::var("POLYGON_RPC_URL").unwrap();
        let signer_key = std::env::var("SIGNER_PRIVATE_KEY").unwrap();
        let proxy_address = std::env::var("PROXY_ADDRESS").unwrap();

        let wallet = WalletService::new(&rpc_url, &signer_key, &proxy_address).unwrap();
        let (matic, usdc) = wallet.check_balances().await.unwrap();

        println!("MATIC: {}", matic);
        println!("USDC: {}", usdc);
    }
}
