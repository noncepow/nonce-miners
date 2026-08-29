/**
 * Submit strategy (spec §3.4).
 *
 * Every submit costs the fee whether or not it improves the miner's best, and a
 * wallet gets at most 10 per epoch. So the default is to sit on the best hash
 * until the epoch is nearly over and send once — and only reroll early when the
 * improvement is large enough to be worth another fee.
 */

export const DEFAULT_STRATEGY = {
  /** Contract cap; see MAX_SUBMITS_PER_EPOCH. */
  maxSubmits: 10,
  /** Reroll only when the new best beats the submitted one by this factor. */
  rerollFactor: 2n,
  /** Send the first submit once the epoch has this many ms left. */
  submitLeadMs: 6_000,
  /** Skip submitting at all below this score — saves the fee on junk hashes. */
  minScore: 0n,
};

export function createStrategy(overrides = {}) {
  const config = { ...DEFAULT_STRATEGY, ...overrides };
  if (config.maxSubmits < 1 || config.maxSubmits > 10) {
    throw new Error("maxSubmits must be between 1 and 10");
  }
  if (config.rerollFactor < 1n) throw new Error("rerollFactor must be >= 1");
  return config;
}

/**
 * @param {object} state
 * @param {{score: bigint}|null} state.best        best hash held this epoch
 * @param {{score: bigint}|null} state.submitted   best hash already submitted
 * @param {number} state.submitsUsed               submits spent this epoch
 * @param {number} state.msLeftInEpoch
 * @param {object} [config]
 * @returns {{submit: boolean, reason: string}}
 */
export function shouldSubmit(state, config = DEFAULT_STRATEGY) {
  const { best, submitted, submitsUsed, msLeftInEpoch } = state;

  if (!best) return { submit: false, reason: "no valid hash yet" };
  if (submitsUsed >= config.maxSubmits) return { submit: false, reason: "submit cap reached" };
  if (best.score < config.minScore) return { submit: false, reason: "below min score" };

  if (!submitted) {
    return msLeftInEpoch <= config.submitLeadMs
      ? { submit: true, reason: "epoch closing" }
      : { submit: false, reason: "holding for a better hash" };
  }

  // Already submitted: only pay again for a materially better hash, and only
  // while there is still time for it to land in this epoch.
  if (msLeftInEpoch <= 0) return { submit: false, reason: "epoch over" };
  if (best.score >= submitted.score * config.rerollFactor) {
    return { submit: true, reason: "reroll: materially better hash" };
  }
  return { submit: false, reason: "improvement too small to pay another fee" };
}

/** Per-epoch bookkeeping the caller resets when the epoch number changes. */
export function newEpochState(epoch) {
  return { epoch, best: null, submitted: null, submitsUsed: 0, hashes: 0, startedAt: Date.now() };
}
