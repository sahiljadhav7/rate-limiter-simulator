# Rate limiting and overload resources

## Knowledge

- [Stripe engineering: "Scaling your API with rate limiters"](https://stripe.com/blog/rate-limiters)
  Why production APIs rate limit, and the token bucket in practice. Use for: the motivation behind the Limiter.
- [Cloudflare: "How we built rate limiting capable of scaling to millions of domains"](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
  Explains the sliding window counter estimate this project implements. Use for: `src/sim/limiter.ts`.
- [Wikipedia: Token bucket](https://en.wikipedia.org/wiki/Token_bucket)
  The algorithm's definition, capacity and refill. Use for: token bucket bursts.
- [AWS Builders' Library: "Timeouts, retries, and backoff with jitter"](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
  How retries amplify load and why backoff and jitter help. Use for: the Retry storm Scenario and Retry Policy modes.
- [AWS Architecture blog: "Exponential Backoff and Jitter"](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
  Simulations comparing backoff strategies. Use for: why "Back off with jitter" exists.
- [AWS Builders' Library: "Using load shedding to avoid overload"](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/)
  Goodput, wasted work on timed-out requests, bounded queues. Use for: the Goodput collapse Scenario.
- [Google SRE book: "Handling Overload"](https://sre.google/sre-book/handling-overload/)
  Per-client limits, retries and overload in real systems. Use for: Noisy neighbor and Retry storm.
- [Google SRE book: "Addressing Cascading Failures"](https://sre.google/sre-book/addressing-cascading-failures/)
  Queues, timeouts and retries causing collapse. Use for: Backend saturation and queue overflow.

## Wisdom (Communities)

- Not chosen yet. Ask your agent for suggestions if you want somewhere to discuss the project with practitioners.

## Gaps

- No beginner-level queueing theory source yet (why a queue grows fast near 100% busy).
