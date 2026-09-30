# Leaky bucket is a queue, so the Limiter can Delay

A leaky bucket built as a meter (reject when the bucket is full) is mathematically the same as a token bucket with the same capacity and rate. The burst-tolerance scenario would then show two identical Variants and teach nothing. We model leaky bucket as a bounded queue instead: the Limiter can answer **Delay** (release the Attempt at a later time) as well as Allow and Reject. A full queue rejects, and the Attempt's timeout keeps running while it waits.

## Consequences

- The Limiter interface has three outcomes, not two, and the engine needs a release event. Both are built in Core (RS-7) even though leaky bucket itself is Stretch, so adding it later does not change code that is already done.
- Delay time counts toward Attempt latency, so a leaky bucket that queues too much shows up as timeouts rather than rejections.
