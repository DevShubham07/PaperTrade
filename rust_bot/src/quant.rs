/// Fair value calculation engine using gamma compression model
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use std::cmp;

/// The "Gamma Compressor" - calculates fair value for prediction market tokens
pub struct QuantEngine;

impl QuantEngine {
    /// Calculate fair value for a token given current market conditions
    ///
    /// # Arguments
    /// * `spot_price` - Current BTC spot price
    /// * `strike_price` - Market strike price
    /// * `minutes_remaining` - Minutes until market expiry
    ///
    /// # Returns
    /// Fair value probability in [0.01, 0.99] range
    pub fn calculate_fair_value(
        spot_price: Decimal,
        strike_price: Decimal,
        minutes_remaining: f64,
    ) -> Decimal {
        // Distance from strike (how far are we from the strike price)
        let distance = spot_price - strike_price;

        // Sensitivity decreases as expiry approaches
        // At 15 min: sensitivity = 300 (low sensitivity)
        // At 1 min: sensitivity = 20 (high sensitivity)
        let sensitivity = Decimal::from_f64(f64::max(20.0, minutes_remaining * 20.0))
            .unwrap_or(Decimal::from(20));

        // Raw "UP" probability
        let shift = distance / sensitivity;
        let prob_up = Decimal::from_str("0.50").unwrap() + shift;

        // Clamp to [0.01, 0.99] range
        Self::clamp(
            prob_up,
            Decimal::from_str("0.01").unwrap(),
            Decimal::from_str("0.99").unwrap(),
        )
    }

    /// Determine which token to trade and its fair value
    ///
    /// Returns (token_to_trade, fair_value, direction)
    /// - token_to_trade: "UP" or "DOWN"
    /// - fair_value: probability in [0.01, 0.99]
    /// - direction: "LONG" (bullish) or "SHORT" (bearish)
    pub fn select_trading_direction(
        spot_price: Decimal,
        strike_price: Decimal,
        minutes_remaining: f64,
    ) -> (String, Decimal, String) {
        let distance = spot_price - strike_price;
        let prob_up = Self::calculate_fair_value(spot_price, strike_price, minutes_remaining);

        if distance >= Decimal::ZERO {
            // BTC above strike: trade UP token
            ("UP".to_string(), prob_up, "LONG".to_string())
        } else {
            // BTC below strike: trade DOWN token (inverted probability)
            let fair_down = Decimal::ONE - prob_up;
            ("DOWN".to_string(), fair_down, "LONG".to_string())
        }
    }

    /// Calculate entry target price (fair value - discount)
    pub fn calculate_entry_price(fair_value: Decimal, panic_discount: Decimal) -> Decimal {
        let target = fair_value - panic_discount;
        Self::clamp(
            target,
            Decimal::from_str("0.01").unwrap(),
            Decimal::from_str("0.99").unwrap(),
        )
    }

    /// Calculate take profit target
    pub fn calculate_take_profit(entry_price: Decimal, scalp_profit: Decimal) -> Decimal {
        let target = entry_price + scalp_profit;
        Self::clamp(
            target,
            Decimal::from_str("0.01").unwrap(),
            Decimal::from_str("0.99").unwrap(),
        )
    }

    /// Calculate stop loss trigger price
    pub fn calculate_stop_loss(entry_price: Decimal, stop_loss_threshold: Decimal) -> Decimal {
        let target = entry_price - stop_loss_threshold;
        Self::clamp(
            target,
            Decimal::from_str("0.01").unwrap(),
            Decimal::from_str("0.99").unwrap(),
        )
    }

    /// Calculate position size based on capital and price
    pub fn calculate_position_size(
        max_capital: Decimal,
        entry_price: Decimal,
    ) -> Decimal {
        if entry_price <= Decimal::ZERO {
            return Decimal::ZERO;
        }

        let size = max_capital / entry_price;
        size.floor() // Round down to whole shares
    }

    /// Check if order price needs updating (> 2 cent drift)
    pub fn should_update_order(current_price: Decimal, new_target_price: Decimal) -> bool {
        let drift = (current_price - new_target_price).abs();
        drift > Decimal::from_str("0.02").unwrap()
    }

    /// Validate spread is acceptable
    pub fn is_spread_acceptable(spread: Decimal, max_spread: Decimal) -> bool {
        spread <= max_spread
    }

    /// Clamp a decimal value between min and max
    fn clamp(value: Decimal, min: Decimal, max: Decimal) -> Decimal {
        if value < min {
            min
        } else if value > max {
            max
        } else {
            value
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fair_value_at_strike() {
        // When BTC = strike, fair value should be ~0.50
        let spot = Decimal::from(98500);
        let strike = Decimal::from(98500);
        let minutes = 10.0;

        let fair = QuantEngine::calculate_fair_value(spot, strike, minutes);
        assert!((fair - Decimal::from_str("0.50").unwrap()).abs() < Decimal::from_str("0.01").unwrap());
    }

    #[test]
    fn test_fair_value_above_strike() {
        // When BTC > strike, fair value should be > 0.50
        let spot = Decimal::from(99000);
        let strike = Decimal::from(98500);
        let minutes = 10.0;

        let fair = QuantEngine::calculate_fair_value(spot, strike, minutes);
        assert!(fair > Decimal::from_str("0.50").unwrap());
    }

    #[test]
    fn test_fair_value_below_strike() {
        // When BTC < strike, fair value should be < 0.50
        let spot = Decimal::from(98000);
        let strike = Decimal::from(98500);
        let minutes = 10.0;

        let fair = QuantEngine::calculate_fair_value(spot, strike, minutes);
        assert!(fair < Decimal::from_str("0.50").unwrap());
    }

    #[test]
    fn test_fair_value_clamping() {
        // Extreme values should be clamped
        let spot = Decimal::from(110000);
        let strike = Decimal::from(98500);
        let minutes = 1.0;

        let fair = QuantEngine::calculate_fair_value(spot, strike, minutes);
        assert!(fair >= Decimal::from_str("0.01").unwrap());
        assert!(fair <= Decimal::from_str("0.99").unwrap());
    }

    #[test]
    fn test_direction_selection() {
        let spot = Decimal::from(99000);
        let strike = Decimal::from(98500);
        let minutes = 10.0;

        let (token, fair, direction) = QuantEngine::select_trading_direction(spot, strike, minutes);
        assert_eq!(token, "UP");
        assert_eq!(direction, "LONG");
        assert!(fair > Decimal::from_str("0.50").unwrap());
    }

    #[test]
    fn test_position_sizing() {
        let capital = Decimal::from(100);
        let price = Decimal::from_str("0.45").unwrap();

        let size = QuantEngine::calculate_position_size(capital, price);
        assert_eq!(size, Decimal::from(222)); // 100 / 0.45 = 222.22... -> 222
    }

    #[test]
    fn test_order_update_logic() {
        let current = Decimal::from_str("0.45").unwrap();
        let new_close = Decimal::from_str("0.46").unwrap();
        let new_far = Decimal::from_str("0.48").unwrap();

        assert!(!QuantEngine::should_update_order(current, new_close)); // 1 cent drift
        assert!(QuantEngine::should_update_order(current, new_far));    // 3 cent drift
    }
}
