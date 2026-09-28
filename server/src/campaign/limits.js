/** Token-bucket rate limiter and the retry policy, both interruptible. */

export class RateLimiter {
    /**
     * @param {number} rate messages per second
     * @param {number} burst how many may go at once after an idle period
     * @param {() => number} now monotonic clock, injectable for tests
     */
    constructor(rate = 1, burst = 1, now = () => performance.now() / 1000) {
        this.setRate(rate, burst);
        this.now = now;
        this.tokens = this.burst;
        this.updated = now();
    }

    setRate(rate, burst = this.burst ?? 1) {
        if (!(rate > 0)) throw new RangeError('rate must be greater than 0');
        this.rate = rate;
        this.burst = Math.max(1, burst);
    }

    /** Seconds to wait before the next send is allowed (0 when ready). */
    delay() {
        const now = this.now();
        this.tokens = Math.min(this.burst, this.tokens + (now - this.updated) * this.rate);
        this.updated = now;
        if (this.tokens >= 1) return 0;
        return (1 - this.tokens) / this.rate;
    }

    /** Spend one token. Call only once the delay has elapsed. */
    consume() {
        this.tokens = Math.max(0, this.tokens - 1);
    }

    /**
     * Wait for a slot. `shouldStop` is polled so a stopped campaign does not
     * sit here for the rest of a long delay; resolves false when it stops.
     */
    async acquire(shouldStop = () => false) {
        for (;;) {
            if (shouldStop()) return false;
            const wait = this.delay();
            if (wait <= 0) {
                this.consume();
                return true;
            }
            await sleep(Math.min(wait, 0.1) * 1000);
        }
    }
}

export class RetryPolicy {
    constructor({ maxRetries = 3, delay = 2, backoff = 2, maxDelay = 60, jitter = 0.25,
                  random = Math.random } = {}) {
        this.maxRetries = maxRetries;
        this.delay = delay;
        this.backoff = backoff;
        this.maxDelay = maxDelay;
        this.jitter = jitter;
        this.random = random;
    }

    static fromConfig(config) {
        return new RetryPolicy({
            maxRetries: config.maxRetries,
            delay: config.retryDelay,
            backoff: config.retryBackoff,
            maxDelay: config.retryMaxDelay,
            jitter: config.retryJitter,
        });
    }

    /** Only retryable failures are retried, and only while attempts remain. */
    shouldRetry(attempt, retryable) {
        return Boolean(retryable) && attempt <= this.maxRetries;
    }

    /** Exponential backoff with jitter, so retries do not synchronise. */
    delayFor(attempt) {
        const base = Math.min(this.maxDelay, this.delay * this.backoff ** Math.max(0, attempt - 1));
        if (!this.jitter) return base;
        const spread = base * this.jitter;
        return Math.max(0, base + (this.random() * 2 - 1) * spread);
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep in slices so a stop request is noticed quickly. Returns false if stopped. */
export async function interruptibleSleep(seconds, shouldStop = () => false) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        if (shouldStop()) return false;
        await sleep(Math.min(100, end - Date.now()));
    }
    return !shouldStop();
}
