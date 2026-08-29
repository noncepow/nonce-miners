//! When to spend a fee on a submission.
//!
//! Mirrors `packages/miner/src/strategy.js`. Every submission costs the fee
//! whether or not it improves the wallet's best, and the contract allows at most
//! ten per epoch — so the default holds the best hash until the epoch is nearly
//! over and sends once, rerolling early only on a materially better result.

use primitive_types::U256;

pub struct Strategy {
    pub max_submits: u32,
    pub reroll_factor: U256,
    pub lead_ms: i64,
}

pub fn should_submit(
    best: Option<U256>,
    submitted: Option<U256>,
    submits_used: u32,
    ms_left: i64,
    config: &Strategy,
) -> bool {
    let Some(best) = best else { return false };
    if submits_used >= config.max_submits {
        return false;
    }

    match submitted {
        // Nothing sent yet: wait for the close so the best possible hash goes.
        None => ms_left <= config.lead_ms,
        // Already sent: only pay again for a materially better hash, and only
        // while there is still time for it to land in this epoch.
        Some(prev) => ms_left > 0 && best >= prev.saturating_mul(config.reroll_factor),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Strategy {
        Strategy { max_submits: 10, reroll_factor: U256::from(2), lead_ms: 6_000 }
    }

    #[test]
    fn holds_until_the_epoch_is_closing() {
        assert!(!should_submit(Some(U256::from(100)), None, 0, 30_000, &cfg()));
        assert!(should_submit(Some(U256::from(100)), None, 0, 3_000, &cfg()));
    }

    #[test]
    fn does_not_submit_without_a_hash() {
        assert!(!should_submit(None, None, 0, 1_000, &cfg()));
    }

    #[test]
    fn respects_the_submit_cap() {
        assert!(!should_submit(Some(U256::from(100)), None, 10, 1_000, &cfg()));
    }

    #[test]
    fn rerolls_only_past_the_factor() {
        let prev = Some(U256::from(100));
        assert!(!should_submit(Some(U256::from(199)), prev, 1, 20_000, &cfg()));
        assert!(should_submit(Some(U256::from(200)), prev, 1, 20_000, &cfg()));
    }

    #[test]
    fn never_rerolls_after_the_epoch_ends() {
        let prev = Some(U256::from(1));
        assert!(!should_submit(Some(U256::from(1000)), prev, 1, 0, &cfg()));
    }
}
