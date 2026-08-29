/** Distinguishes the three failure modes §8 treats differently. */
export class TransportError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = true) {
    super(message);
    this.name = "TransportError";
  }
}

/** The model answered, but the answer did not fit the contract. Never retried
 *  blindly — re-prompted with the validation error attached (§4). */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
    readonly raw: string,
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/** Safety classifier declined. Not retryable, not a bug — escalate. */
export class RefusalError extends Error {
  constructor(message: string, readonly category: string | null) {
    super(message);
    this.name = "RefusalError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string, readonly dimension: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * The model ran out of room mid-JSON.
 *
 * Distinct from a transport failure because the fix is different and known: the
 * answer was not wrong, there was not space to finish it. Retrying the same
 * call unchanged reproduces it exactly, so the client retries with more
 * headroom instead — see `LlmClient.structured`.
 *
 * It used to be a non-retryable `TransportError`, which failed the node and
 * every node downstream of it. A dense résumé would blow a 4,000-token gap
 * analysis and take the whole tailoring run with it, printing advice to raise
 * a constant nobody outside the repository can edit.
 */
export class TruncatedError extends Error {
  override readonly name = "TruncatedError";
  constructor(
    message: string,
    /** The ceiling that was hit, so the caller can ask for more than it. */
    readonly maxTokens: number,
  ) {
    super(message);
  }
}
