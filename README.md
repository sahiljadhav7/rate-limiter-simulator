# Ratescale

Ratescale is a rate-limiting simulator for students. The same seeded traffic runs through two rate limiters side by side, you raise the load until something breaks, and the page shows what broke and why.

It is for anyone who has read "a token bucket refills at N per second" and wants to see what that means when traffic arrives in bursts. You do not need a queueing theory course; every number on the page is explained in plain words.

**Live:** [rate-limiter-simulator-zeta.vercel.app](https://rate-limiter-simulator-zeta.vercel.app/). Try [Backend overload at 30 Requests per second](https://rate-limiter-simulator-zeta.vercel.app/?s=backend-overload&seed=1&d=30&r=none.none), where the sliding window counter's Backend fails.

![Backend overload: Demand is dragged from 10 to 40 Requests per second, and the sliding window counter's Backend turns red and starts losing Attempts while the token bucket's stays blue](docs/backend-overload.gif)

_Backend overload at seed 1: Demand dragged from 10 to 40 Requests per second. The sliding window counter's Backend says FAILING with 31 to 34% LOST in this recording; the token bucket's keeps up. Recorded in headless Chrome from the dev server._

## The two Scenarios

A Scenario is one lesson: the traffic, the Backend (the simulated service behind the rate limiter) and the Variants being compared. Each one explains itself in two handwritten notes under the panels.

**Backend overload** (opens by default). Both rate limiters allow 70 Requests a second, under the Backend's 80, and traffic comes in bursts: 1 second on, 4 seconds off. After a quiet gap the sliding window counter lets a whole window of 70 in at once, too fast for the Backend, so its queue fills and it sheds Attempts. The token bucket holds only 10, then lets the rest in one at a time.

- At the default Demand of 10 a second, neither goes amber or red; at 30 and 40 a second, the sliding window counter's Backend fails with queue overflow as the Root Cause and the token bucket's never does (`tests/scenario-findings.test.ts`).
- Goodput (Requests that succeeded, per second) at 20, 30 and 40 a second, over 8 seeds: sliding window counter 13.7, 11.6 and 9.9, so more traffic gets less work done; token bucket 15.4 to 15.7 (recorded in `src/ui/scenarios/backend-overload.ts`).

**Edge burst.** Fixed window against sliding window counter, both allowing 10 a second, with 30 Requests arriving 50 ms before a window edge and 30 more just after. The fixed window starts counting from zero at each edge, so it lets 20 through in one window-length at every burst; the sliding window counter lets 10 to 12 through (`tests/scenario-edge-burst.test.ts`).

## Sharing a setup

The address bar always holds the current setup, and **Share** copies it. Demand goes in when you let go of the slider, not on every step of a drag:

```
?s=backend-overload&seed=1&d=10&r=none.immediate
```

| Key    | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `s`    | Scenario: `backend-overload` or `edge-burst`                                     |
| `seed` | The seed every random stream starts from, a whole number from 0 to 4,294,967,295 |
| `d`    | Demand: new Requests per second, from 0 to 1,000                                 |
| `r`    | Each Variant's Retry Policy, in panel order, joined by `.`                       |

Retry Policies are `none`, `immediate`, `backoff`, `backoff-jitter` and `retry-after`. Anything missing or invalid falls back to the Scenario's own value, one key at a time.

A link restores the setup, not the run: it opens at 0 seconds, ready to drag. A fresh run from the same setup is exact in any browser, while replaying a whole run is not exact across JavaScript engines (their last digits of floating point maths differ).

## Running it locally

You need [Bun](https://bun.sh) 1.3.9 or later.

```sh
bun install
bun run dev        # http://localhost:5173
bun run test       # the whole test suite (Vitest)
bun run build      # type check and production build into dist/
bun run preview    # serve dist/
bun run lint
bun run format:check
```

Use `bun run test`, not `bun test`: the second starts Bun's own test runner, which finds nothing useful here.

## Architecture

```
src/sim/      the engine: event loop, traffic, limiters, Backend, metrics, diagnosis. Pure TypeScript
src/runner/   builds one engine per Variant, moves them forward together, enforces the event budget
src/ui/       React: panels, charts, controls, notes, Share
tests/        invariants, limiters, queueing behaviour, diagnosis, Scenarios
```

- **The engine is a discrete-event simulation.** Each Variant has its own event queue: Attempts arrive, the rate limiter decides (allow, reject or delay), the Backend starts or queues or sheds them, and timeouts and retries are scheduled as events. Every number on the page is counted from those events; percentiles come from recorded latencies.
- **`src/sim` knows nothing about the page.** No React, no DOM, no timers, no global state. That keeps it testable from a script and lets it move to a Web Worker later.
- **Determinism.** The only clock is the simulated clock, and the only randomness is seeded random streams: traffic, service times and retry jitter each have their own, so an extra draw in one never shifts the others. Events at the same time run in the order they were scheduled. The same seed and the same Demand changes replay the same run.
- **Shared traffic.** Every Variant sees the exact same Requests at the exact same times, so any difference between panels comes from the rate limiter and Retry Policy alone.
- **The event budget.** Each animation frame advances simulated time by at most 100 ms times the speed, and handles at most 12,000 events across all Variants. When a frame runs out, the ledger says RUNNING SLOWER THAN REQUESTED instead of dropping events or skipping time.

## What this models and what it leaves out

**Close to reality:**

- The algorithms themselves: the same arithmetic production rate limiters use, including the fixed window's burst at the window edge
- Queueing: latency stays flat, then shoots up as the Backend nears full use
- How retries add traffic, and why work for Clients that already gave up still costs the Backend
- Relative comparisons between designs on the same traffic

**Not close:**

- Absolute numbers: a p99 (the latency 99 in 100 Attempts beat) of 340 ms predicts nothing about a real service
- Networks: packet loss, variable latency, connection setup
- Real Backends: garbage collection pauses, CPU contention, connection pools, caches
- Real traffic: daily patterns, correlated bursts, long tails, bots
- Several rate limiter nodes sharing a count: races between checking and counting, failover, clocks that drift, and whether to allow or reject everything when the shared count is unreachable

Trust it for "why does this happen, and which design handles it better". Do not trust it for "how many requests can my real system take".

## How the numbers are checked

- **Invariants** (`tests/invariants.test.ts`): every Attempt ends exactly one way and every Request is accounted for, no Request makes more Attempts than its Retry Policy allows, no count is negative or NaN, utilization stays between 0 and 1, the queue never passes its limit, and the per-second numbers add up to the totals. Checked for every rate limiter, Retry Policy and traffic shape together.
- **Limiters** (`tests/limiters.test.ts`): each algorithm's counting rules, globally and per Client, and how they differ on the same traffic: across a window edge only fixed window lets about twice its limit through, and after a burst and a quiet spell the sliding window counter still remembers the burst.
- **Queueing** (`tests/backend.test.ts`): utilization against theory, with fixed seeds and explicit tolerance bands, so no test passes on some seeds and fails on others.
- **Replay** (`tests/runner.test.ts`): a run rebuilt from its seed and its recorded Demand changes gives the identical numbers.
- **Scenarios** (`tests/scenario-findings.test.ts`, `tests/scenario-edge-burst.test.ts`): each lesson is visible where it should be and calm where it should be.
- **Continuous integration** (`.github/workflows/ci.yml`): lint, format check, tests and build on every push and pull request to `main`. The Vercel build runs the tests again, so a failing test blocks a deploy.

## Deploying

`vercel.json` installs from the lockfile and builds with `bun run test && bun run build`, serving `dist/`. The app is one page with its state in the query string, so it needs no rewrites.

To connect it once:

1. Sign in at [vercel.com](https://vercel.com) and choose **Add New… → Project**.
2. Import `sahiljadhav7/rate-limiter-simulator` from GitHub.
3. Leave the settings as `vercel.json` sets them and press **Deploy**.

After that, every push to `main` redeploys.

## Credits

The visual style (graph paper, floating islands, handwritten notes) follows [Breakscale](https://breakscale.tech/). The notes use [Caveat](https://github.com/googlefonts/caveat) under the SIL Open Font License, bundled with the site through `@fontsource/caveat`.
