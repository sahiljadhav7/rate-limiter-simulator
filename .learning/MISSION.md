# Mission: Understand Ratescale end to end

> Draft, inferred from the first request. Confirm or correct it with your agent.

## Why
Be able to explain every feature of Ratescale, the rate-limiting simulator you are building: what it does, how the code does it, and why it was designed that way. Then you can extend it with confidence and talk about it clearly to others.

## Success looks like
- Explain each of the five Scenarios and the failure it teaches, without notes
- Trace one Attempt from the Demand slider through the Limiter, the Backend and the Retry Policy to the diagnosis card
- Say why determinism (simulated clock, seeded streams, a shared traffic log) matters, and name what would break it
- Do the Backend ceiling arithmetic (`slots × 1000 / meanMs`) before tuning a Scenario

## Constraints
- Learn from the real code in this repo; lessons point at actual files and lines
- Notes are Markdown, kept in `.learning/` and committed to the repo

## Out of scope
- Rate limiter algorithms the project does not model (fixed window, leaky bucket as its own Variant)
