# Ratescale: Base Concept

A rate-limiting simulator in the spirit of [Breakscale](https://github.com/xevrion/breakscale), scoped to rate limiting and its surrounding concepts.

**Target:** core build of about 23 hours (two long days), failure diagnosis on day 3, remaining scenarios and rules as stretch. Estimates in this revision are recomputed from the tickets below (the whole plan is about 42 hours).

## Pitch

**Run the same seeded traffic through different rate limiters side by side, push the load until something breaks, and get told what broke, why, and how to fix it.**

A fixed layout: traffic generator → limiter → backend with finite capacity, with two or three limiters running in parallel panels. No drag-and-drop canvas.

Principles borrowed from Breakscale:
- Every number comes from a real discrete-event simulation. Nothing is faked or animated to look plausible.
- The engine has no UI dependency and can be driven from a script.
- Deterministic: the same seed, config and control timeline replay identically.
- Correctness is covered by invariant tests (request conservation, no NaN, bounds).

## What you are building (in one paragraph)

A teaching tool, not a production limiter. Nothing real is sent over a network. Your code invents fake requests, pushes them through your own implementations of the limiting algorithms, and measures what happens. Static diagrams say "token bucket refills at N per second"; this shows *why* fixed window lets through double the limit at a window edge, or how clients retrying on 429 make an overload worse.

## Definition of done and demo script

**Done means:**
- Deployed on Vercel at a public URL
- Test suite passes in CI before deploy
- README with a GIF, architecture section and a "what this models and leaves out" section

**60-second demo (three things to show):**
1. **Boundary burst** (about 15 s): fixed window vs sliding window on the same traffic; the fixed-window panel admits about 2x the limit at the window edge.
2. **Retry storm** (about 20 s): immediate retry vs backoff with jitter; offered load balloons and goodput collapses in one panel only.
3. **Diagnosis card** (about 25 s): the app names the failure, shows the evidence numbers, and one click re-runs with the fix. *(Needs the day-3 tickets RS-26 and RS-27. Until then the demo is items 1 and 2 plus dragging the rate slider.)*

## Concepts to cover

### Algorithms (all behind one interface)
- **Fixed window**: shows the boundary-burst flaw (2x the limit across a window edge)
- **Sliding window log**: accurate but memory-heavy
- **Sliding window counter**: the practical approximation
- **Token bucket**: allows bursts
- **Leaky bucket**: smooths output

### Scenarios (each isolates one lesson)
1. **Boundary burst**: fixed window vs sliding window *(core)*
2. **Retry storm**: immediate retry on 429 vs exponential backoff with jitter *(core)*
3. **Noisy neighbor**: global limit vs per-client limit; one client starves everyone else
4. **Burst tolerance**: token bucket vs leaky bucket under spiky traffic
5. **Distributed limiter**: N nodes with local counters vs a shared counter; effective limit becomes N x limit
6. **Rate limiting vs load shedding**: limiter on/off in front of an overloaded backend, comparing goodput and p99

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript | Many shapes (events, configs, snapshots); types keep them honest |
| UI | React | Panels and controls are simple stateful components |
| Build/dev | Vite | Zero-config TS + React, static output |
| Charts | Hand-drawn SVG | Charts are just lines and bars; no library weight, predictable rendering |
| Tests | Vitest | Same config as Vite; engine is pure TS, testable without a browser |
| CI | GitHub Actions (or Vercel build command) | Run tests before every deploy |
| Package manager | Bun (or npm) | Breakscale uses Bun; either works |
| Randomness | Seeded RNG (mulberry32) | Determinism: replayable runs, stable tests |
| Hosting | Vercel (Hobby) | Static deploy, free |

**Deliberately not in the stack:** no backend, no database, no auth, no WebSockets, no Redis. The "distributed limiter" scenario simulates multiple nodes and a shared counter in plain TypeScript, where latency and clock skew are dials you control. A real backend would add network jitter (breaking determinism), turn every animation frame into a round trip, and make results less trustworthy as a teaching tool.

## Hosting and CI

- Deploy as a **pure static site** on Vercel Hobby (free). Connect the GitHub repo; every push to `main` redeploys.
- **CI gate:** either a GitHub Action that runs the tests on every push, or set the Vercel build command to `bun run test && bun run build` so a failing test blocks the deploy (about 15 minutes to set up).
- The simulation runs in each visitor's browser, so hosting cost does not scale with how heavily people use it. 10 users is negligible against the Hobby plan's 100 GB bandwidth.
- Hobby is **non-commercial use only**. Fine for a free teaching tool and portfolio project; ads or paid tiers would need Pro or another host.
- Add a `vercel.json` rewrite to `index.html` if using client-side routing, so deep links do not 404.
- **Shareable state in the URL:** preset id, parameters and seed. Live slider moves are coalesced (at most one control event per 0.5 s of sim time), and the full control timeline is included only for scripted presets. Long custom runs export as a JSON file instead of a giant URL.
- No serverless functions or API routes, so no invocation limits to think about.
- Escape hatch if ever needed: Cloudflare Pages (unmetered static bandwidth); a Vite static build moves over unchanged.

---

# High-Level Design

## Goals and non-goals

**Goals:** a deterministic, UI-free simulation engine; side-by-side comparison of rate limiters on identical traffic; live load control; measured (never faked) metrics; rule-based failure diagnosis with evidence.

**Non-goals:** a drag-and-drop canvas, real networking, persistence, auth, predicting real-world absolute performance.

## Architecture

```
┌──────────────────────────── React UI (src/ui) ────────────────────────────┐
│  Controls · Scenario picker · N x Panel (charts + stats) · Explainer      │
│  Diagnosis card · chart markers                                           │
└───────────────▲───────────────────────────────────────┬───────────────────┘
                │ snapshots + findings (per frame)      │ config, seed, control events
┌───────────────┴───────────────────────────────────────▼───────────────────┐
│                          Runner (src/runner)                              │
│   builds N Engines from a Scenario, advances them in lockstep,            │
│   enforces the per-frame event budget                                     │
└───────────────▲───────────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────── Sim Engine (src/sim, no React/DOM) ───────────┐
│                                                                           │
│  Shared TrafficSource ──arrivals──▶ Client(s) ──req──▶ Limiter ──▶ Backend│
│  (lazy, rate from            (retry/backoff,     (algo, keyBy)  (slots +  │
│   control timeline)           timeout)   ▲              │        FIFO q)  │
│                                          └──── 429 ◀────┘  ◀─ response ─┘ │
│                                                                           │
│  EventQueue (min-heap) · SimClock · SeededRNG · MetricsCollector          │
│  Diagnoser (rules over snapshot history → Findings)                       │
└───────────────────────────────────────────────────────────────────────────┘
```

## Key design decisions

1. **Discrete-event simulation.** A min-heap event queue ordered by simulated time, with a sequence-number tiebreaker so equal timestamps always pop in insertion order. Events: `ARRIVAL`, `DECISION`, `SERVICE_END`, `RETRY`, `TIMEOUT`, `SAMPLE`. The engine advances by popping events up to `now + dt`, so the UI can run at any speed.
2. **Lazy shared traffic source (supports live load control).** One `TrafficSource` generates arrivals just ahead of the simulated clock using the *current* rate, appending to a shared log that every panel's engine reads. All panels still see identical traffic, so the comparison stays fair. Poisson inter-arrivals are memoryless, so changing the rate mid-run is statistically correct. Each engine owns its own clients, limiter, backend and metrics, because retries depend on responses and diverge per panel.
3. **Control timeline for determinism.** Every control change is recorded as `{ simTime, change }`. Seed + control timeline replays a run exactly, including slider moves, so a run can be exported or used as a test fixture. Changes apply at the current sim time, never retroactively.
4. **Limiter is a deterministic, time-injected strategy.** `allow(clientId, now) -> { ok, retryAfterMs? }`. It holds per-key state, but it never reads the clock or RNG itself, only the `now` it is given. That makes it fully replayable and easy to test. `LimiterSpec.keyBy` decides whether state is one global bucket or one per client.
5. **Store latency is modeled with a `DECISION` event.** On `ARRIVAL`, the engine schedules `DECISION` at `now + storeLatency` (zero for local stores, handled inline) and calls `allow()` when it fires. `allow()` itself stays synchronous.
6. **Distributed limiting is a wrapper, not a special case.** N `LimiterNode`s, each with a `CounterStore`. `LocalStore` = per-node counters (effective limit N x L). `SharedStore` = one counter with configurable latency and optional clock skew.
7. **Backend is a finite-slot server; clients have timeouts.** Capacity slots plus a FIFO queue with a limit, gamma-distributed service times (`shape = 1/cv^2`, `scale = mean * cv^2`). Clients give up after `timeoutMs` (a `TIMEOUT` event); an abandoned request still occupies backend capacity until it finishes, which is what makes goodput collapse possible.
8. **Metrics are measured.** Counters bucketed per second, latency percentiles from a ring buffer of completed request latencies, and allowed-request counts at sub-window resolution (see Metrics glossary). The first 5 simulated seconds are a **warm-up** and are excluded from diagnosis.
9. **Diagnosis is computed, not scripted.** Rule-based findings derived from measured metrics, each carrying its evidence (see below).
10. **Determinism.** Seeded RNG (mulberry32) and the simulated clock only. Separate RNG streams for traffic, service times and retry jitter, so adding a draw in one place does not shift the others. Never `Date.now()` or `Math.random()` inside the engine.

## Load control

**Live, while running:**
- Total request rate slider (requests per second)
- Greedy-client multiplier (one client sends N x the others; drives noisy-neighbor)
- Burst button (e.g. 5x rate for 2 seconds on demand)
- Traffic shape: constant, Poisson, or bursty on/off
- Simulation speed: 0.5x, 1x, 10x
- One-click load presets: **ramp** (10 to 500 rps over a minute), **spike**, **step**

**Before or between runs:**
- Limiter settings (algorithm, key scope, limit, window, bucket size, refill rate)
- Backend capacity (slots, queue limit, mean service time, cv)
- Client policy (timeout, retry mode, max attempts, base delay)
- Seed

**Guardrails:** cap at roughly 1,000 rps per panel and show a warning above that; the runner also enforces an events-per-frame budget (see Performance).

## Failure diagnosis ("what broke, why, how to fix")

A `Diagnoser` in `src/sim/` reads the snapshot history once per simulated second on a rolling window and returns findings. Every finding is derived from measured values with explicit thresholds; nothing is hardcoded per scenario. The first 5 s (warm-up) are ignored.

```ts
interface Finding {
  id: FailureMode;                                // e.g. 'retry-storm'
  label: string;                                  // "Retry storm"
  severity: 'warn' | 'broken';
  startedAt: number;                              // sim time it first triggered
  evidence: { metric: string; value: string }[];  // numbers that fired the rule
  why: string;                                    // template filled from evidence
  fixes: Fix[];                                   // ranked suggestions
  role: 'root-cause' | 'downstream';
}

interface Fix {
  text: string;
  patch?: Partial<PanelConfig>;                   // optional: one-click "apply and re-run"
}
```

### Detection rules

"Baseline p99" means the **theoretical p99 of the backend's service-time distribution** (computable from mean and cv), so it is well defined even when a scenario starts overloaded.

| Failure mode | Tier | Fires when | Why (template) | Typical fixes |
| --- | --- | --- | --- | --- |
| Retry storm | cause | offered load (originals + retries) > 1.5x original load, high retries per rejection | Clients retry on 429 with no backoff, so rejections create more traffic than they remove | Exponential backoff + jitter, honor `Retry-After`, cap attempts |
| Boundary burst | cause | fixed-window limiter; allowed requests in any span of one window-length (checked at window/10 resolution) exceed the limit by > 30% | Counter resets at the window edge, so a client can use two windows' worth back to back | Switch to sliding window or token bucket |
| Noisy neighbor | cause | one client holds > 50% of allowed traffic while others' allow rate drops | A global limit is first-come-first-served, so a heavy client crowds out the rest | Per-client limits, weighted fair queuing |
| Distributed over-admit | cause | effective allowed rate > 1.3x configured limit, local stores, N > 1 | Each node counts on its own, so the real limit is about N x limit | Shared counter, or divide the limit by N |
| Limit too loose | cause | limiter rejects ~0 but backend is saturated | Limit is above what the backend can serve, so the limiter protects nothing | Set limit <= backend capacity x safety factor |
| Limit too tight | cause | backend utilization < 40% while rejection rate > 30% | Legitimate traffic is rejected while capacity sits idle | Raise the limit, add burst allowance |
| Backend saturation | effect | utilization >= 95% and p99 > 3x baseline p99 | Arrival rate is near or above capacity, so the queue grows and latency explodes | Lower the limit, add slots, add a cache |
| Queue overflow / load shedding | effect | backend shed count > 0 | Queue hit its limit, so requests are dropped | Smaller limiter limit, bigger queue (with latency warning), autoscale |
| Goodput collapse | effect | goodput < 50% of its own peak while backend utilization stays high | Backend is busy finishing requests callers already abandoned | Shorter queue, timeouts and cancellation, shed earlier |

### Ranking and behavior
- **Two tiers, fixed causal order.** Effect rules are always downstream of any cause rule that fires. Among effects the order is saturation → queue overflow → goodput collapse. Among causes, the earliest `startedAt` is the primary root cause. If no cause fires, the earliest effect is the root cause. The timestamps are shown as evidence, so a reader can see when they disagree with the ordering.
- A finding fires once and clears with hysteresis to avoid flicker.
- Fixes are phrased as "try", not "will", because they are suggestions for this simulated system.

### What the user sees
When the first `broken` finding appears: a vertical marker on the chart at `startedAt`; a card with the label, severity and evidence numbers; a **Why** text built from a template plus actual values (e.g. "Offered load reached 2.4x your traffic setting because 71% of rejected requests were retried within 100 ms"); ranked **How to fix** options, each with **Apply and re-run** when a `patch` exists. The original and fixed runs sit in adjacent panels on the same seeded traffic so the improvement is visible.

## Fidelity: how close to real

**Will match reality closely:**
- The algorithms themselves (same math as production limiters, including the fixed-window boundary burst)
- Queueing behavior (latency flat then shooting up as utilization nears 100%; standard M/G/c-style curves)
- Retry amplification and why abandoned work matters
- Relative comparisons between designs under the same traffic

**Will not match:**
- Absolute numbers (a p99 of 340 ms predicts nothing about a real service)
- Network effects (packet loss, variable latency, connection setup)
- Real backend complexity (GC pauses, CPU contention, connection pools, cache warmth)
- Real traffic (diurnal patterns, correlated bursts, heavy tails, bots)
- Distributed subtleties (check-then-increment races, failover, clock drift that is not a fixed offset, fail-open vs fail-closed when the store is down)

**Trust it for:** "why does this happen and which design handles it better." **Not for:** "how many requests can my server take."

**Keeping it honest:**
1. Put a "what this models and what it leaves out" note on every scenario.
2. Show units and plain-language metric definitions; do not present latency as a benchmark.
3. Validate the backend against queueing theory: low-load mean latency approaches mean service time; utilization = arrival rate x mean service time / slots; Little's law (`L = lambda * W`) holds for measured queue depth and latency.
4. Optional follow-up project: a real Express + Redis limiter load-tested with k6, comparing curve *shape* against the simulator.

## Metrics glossary

| Term | Definition |
| --- | --- |
| Offered load | Arrivals per second at the limiter, **including retries** |
| Allowed / rejected | Limiter decisions per second (`allow()` true / false) |
| Rejection rate | rejected / (allowed + rejected) |
| Throughput | Requests the backend completes per second (including ones the client already abandoned) |
| Goodput | Successful responses delivered **within the client timeout**, per second |
| Latency | Completion time minus arrival time of that attempt at the limiter, including queue wait |
| p50 / p95 / p99 | Percentiles over completed-request latencies in a rolling window |
| Baseline p99 | Theoretical p99 of the service-time distribution (from mean and cv) |
| Utilization | Time-averaged fraction of busy backend slots, in [0, 1] |
| Queue depth | Requests waiting for a slot at sample time |
| Shed | Requests dropped because the backend queue was full |
| Failed | Requests that timed out or were shed |
| Warm-up | First 5 simulated seconds, excluded from diagnosis and baselines |
| Sub-bucket counts | Allowed-request counts at window/10 resolution, used for boundary-burst detection |

## Core types

```ts
type ClientId = string;

interface Limiter {
  allow(id: ClientId, now: number): { ok: boolean; retryAfterMs?: number };
  reset(): void;
}

interface LimiterSpec {
  algo: 'fixed-window' | 'sliding-log' | 'sliding-counter' | 'token-bucket' | 'leaky-bucket';
  keyBy: 'global' | 'client';      // one shared bucket, or one per client
  limit: number;
  windowMs?: number;               // window algorithms
  capacity?: number;               // bucket algorithms
  refillPerSec?: number;
}

interface ClientPolicy {
  timeoutMs: number;               // client gives up after this long
  retry: 'none' | 'immediate' | 'backoff' | 'backoff-jitter' | 'retry-after';
  maxAttempts: number;
  baseDelayMs?: number;
}

interface ControlEvent {
  simTime: number;
  change:
    | { kind: 'rate'; rps: number }
    | { kind: 'greedyMultiplier'; clientId: ClientId; x: number }
    | { kind: 'burst'; multiplier: number; durationMs: number }
    | { kind: 'shape'; shape: 'constant' | 'poisson' | 'bursty' };
}

interface Scenario {
  id: string;
  title: string;
  lesson: string;
  models: string;            // what it models
  leavesOut: string;         // what it leaves out
  seed: number;
  traffic: TrafficSpec[];    // constant | poisson | bursty | greedy
  controls?: ControlEvent[]; // scripted load (ramp, spike, step)
  backend: { slots: number; queueLimit: number; meanMs: number; cv: number };
  panels: {
    label: string;
    limiter: LimiterSpec;
    client: ClientPolicy;
    nodes?: number;
    store?: 'local' | 'shared';
    storeLatencyMs?: number;
  }[];
}

interface Snapshot {
  t: number;
  allowed: number;
  rejected: number;
  goodput: number;
  offeredLoad: number;       // originals + retries
  backendUtil: number;
  queueDepth: number;
  shed: number;
  p50: number;
  p95: number;
  p99: number;
  perClient: Record<ClientId, { sent: number; allowed: number }>;
}
```

## Module layout

```
src/sim/
  clock.ts  rng.ts  eventQueue.ts  engine.ts
  trafficSource.ts  client.ts  backend.ts  metrics.ts
  limiters/
    fixedWindow.ts  slidingLog.ts  slidingCounter.ts
    tokenBucket.ts  leakyBucket.ts
  distributed.ts
  diagnoser.ts  failureModes.ts
  scenarios.ts
src/runner/
  runner.ts
src/ui/
  App.tsx  Panel.tsx  TimeSeries.tsx  Controls.tsx
  Explainer.tsx  DiagnosisCard.tsx
tests/
  limiters.test.ts  engine.test.ts  invariants.test.ts
  queueingTheory.test.ts  diagnoser.test.ts
.github/workflows/ci.yml
```

## Implementation notes

- **Engine loop:** pop events with `time <= untilMs` in order, set `now = e.time`, handle, then set `now = untilMs`.
- **ARRIVAL:** schedule `DECISION` at `now + storeLatency` (inline when zero) and, if the client has a timeout, schedule `TIMEOUT` at `now + timeoutMs`.
- **DECISION:** ask the limiter. Allowed goes to the backend; rejected is recorded and the client's retry policy decides whether to schedule a `RETRY` (honoring `retryAfterMs` when the policy says so).
- **RETRY:** same as arrival but carries an attempt count so backoff grows.
- **TIMEOUT:** if the request has not completed, the client abandons it (counts as failed); backend work already started still runs to completion.
- **SERVICE_END:** free a slot, record latency, pull the next request off the FIFO queue.
- **Backend submit:** free slot means start; otherwise queue if under the limit; otherwise shed.
- **React wiring:** engines live in a `useRef` (they mutate constantly); a `requestAnimationFrame` loop calls `advance(dt * speed)` on every panel; snapshots copy into React state at about 30 fps; charts are SVG polylines from the history arrays.
- **Build order:** walking skeleton first (RNG, clock, heap, then one constant source through fixed window to the backend, `console.log` the snapshot). Then wire **one scenario to a raw SVG polyline before the end of day 1** so integration problems (the animation-frame loop, snapshot shape) surface while they are cheap. Then add the remaining limiters, traffic types and retry policies.

## Performance

- **Events-per-frame budget** in the runner (start around 20,000 events per frame). If exceeded, the simulation slows below the requested speed and the UI shows "running slower than requested." Retries can multiply event counts at high speed and rate, so the budget is what keeps the browser responsive.
- **Worker-ready engine:** no DOM, timers or global state inside `src/sim/`, and snapshots are plain serializable objects, so the engine can move into a Web Worker later without a rewrite. Start on the main thread.
- Rate cap of about 1,000 rps per panel with a UI warning above it.

## Testing strategy

- Request conservation: sent = allowed + rejected; allowed = success + failed + in-flight
- No client exceeds the configured limit over any window (except where the algorithm is supposed to, e.g. fixed window at the boundary)
- Failure breakdown sums to failure total
- Utilization stays within [0, 1]; queue never exceeds its limit
- No snapshot field is ever NaN or Infinity
- Same seed + control timeline produces an identical run
- Queueing-theory checks on the backend (see Fidelity), including Little's law
- Diagnoser: one triggering fixture and one healthy fixture per rule (e.g. retry-storm scenario yields `retry-storm`; a balanced scenario yields no findings). Fixtures live in tests, not only in scenario presets.
- **Statistical tests are not flaky by construction:** fixed seeds, long enough runs, and explicit tolerance bands (e.g. Poisson mean within 3% over 60 simulated seconds); never a fresh random seed per run.
- CI runs the whole suite on every push and gates the deploy.

## Decisions log

| # | Decision | Status |
| --- | --- | --- |
| D1 | Shared-store latency is modeled with a `DECISION` event at `now + storeLatency`; `allow()` stays synchronous | Decided (implement in RS-6, used by RS-13) |
| D2 | `LimiterSpec.keyBy: 'global' \| 'client'` decides bucket scope | Decided (RS-7) |
| D3 | `ClientPolicy.timeoutMs` and a `TIMEOUT` event; abandoned work still burns backend capacity | Decided (RS-6, RS-12) |
| D4 | Baseline p99 = theoretical service-time p99; first 5 s are warm-up and excluded from diagnosis | Decided (RS-6, RS-24) |
| D5 | Boundary-burst detection uses allowed-request counts at window/10 resolution | Decided (RS-6, RS-24) |
| D6 | Diagnosis ranking: cause tier before effect tier, fixed order among effects, earliest cause is root | Decided (RS-24) |
| D7 | URL stores preset + params + seed; slider moves coalesced; long runs export as JSON | Decided (RS-21) |
| D8 | Engine runs on the main thread first; move to a Web Worker only if the event budget is hit in practice | Open |
| D9 | Also report end-to-end latency across retries (successful requests only), alongside per-attempt latency | Open (decide in RS-12) |

---

# Tickets

Every ticket is tagged **[Core]** (days 1 and 2, about 23 hours), **[Day 3]** (about 8 hours) or **[Stretch]** (about 11.5 hours). Whole plan: about 42 hours. Ordered by dependency.

## Epic 0: Setup
- **RS-1 Scaffold repo [Core]** (0.5h): Vite + React + TS, Vitest, prettier and lint.
  - *AC:* `dev`, `test` and `build` all run.

## Epic 1: Sim core
- **RS-2 Seeded RNG + SimClock [Core]** (0.5h): mulberry32 with separate derived streams (traffic, service, jitter).
  - *AC:* same seed gives the same sequence; streams are independent; unit test.
- **RS-3 EventQueue (min-heap) [Core]** (1h): sequence-number tiebreaker for equal timestamps.
  - *AC:* property test that events pop in non-decreasing time and equal times pop in insertion order.
- **RS-4 Traffic generators [Core]** (1.5h): constant, Poisson, bursty (on/off), greedy client.
  - *AC:* Poisson mean rate is within tolerance over a long fixed-seed run.
- **RS-4b Lazy shared TrafficSource + control timeline [Core]** (1.5h): generates arrivals just ahead of the sim clock at the current rate, appends to one shared log read by all panels, records every control change as `{ simTime, change }`. *Depends on RS-2, RS-4.*
  - *AC:* changing the rate mid-run gives the correct new mean rate afterward; all panels see identical arrivals; seed + control timeline replays identically.
- **RS-5 Backend model [Core]** (2h): slots, FIFO queue, queue-limit shedding, gamma service time, abandoned work keeps burning capacity. *Depends on RS-2, RS-3.*
  - *AC:* utilization is <= 1 and queue never exceeds the limit.
- **RS-6 Engine loop + Metrics collector [Core]** (2h): `ARRIVAL`, `DECISION`, `SERVICE_END`, `RETRY`, `TIMEOUT`, `SAMPLE` events; produces `Snapshot`; records latency ring buffer, warm-up flag, and allowed counts at window/10 resolution. *Depends on RS-3 to RS-5.*
  - *AC:* request conservation holds; warm-up seconds are flagged; sub-bucket counts sum to the allowed total.

## Epic 2: Limiters and client behavior
- **RS-7 Limiter interface + Fixed Window [Core]** (1h): includes `keyBy` scope.
  - *AC:* boundary and reset tests; an explicit test showing about 2x the limit across a window edge; global and per-client scope both work.
- **RS-8 Token Bucket [Core]** (1h)
  - *AC:* lazy-refill tests, burst up to capacity, `retryAfterMs` correct.
- **RS-11 Sliding Window Counter [Core]** (1h)
  - *AC:* does not admit 2x the limit across a boundary in the same scenario where fixed window does.
- **RS-12 Client retry policies + timeout [Core]** (1.5h): none, immediate, exponential backoff, backoff plus jitter, `Retry-After`-honoring; `timeoutMs` and `maxAttempts`. Resolves D9. *Depends on RS-6.*
  - *AC:* a retry storm scenario visibly amplifies offered load with immediate retry and not with backoff + jitter; timed-out requests count as failed.
- **RS-14 Invariant test suite [Core]** (1h): no NaN or Infinity, failure breakdown sums to total, same seed + timeline gives an identical run. *Depends on RS-6.*
- **RS-9 Leaky Bucket [Stretch]** (1h)
- **RS-10 Sliding Window Log [Stretch]** (1h)
  - *AC for RS-9 and RS-10:* same shape of tests as the other limiters; Sliding Log never exceeds the limit in any window.
- **RS-13 Distributed wrapper [Stretch]** (2h): N nodes, `LocalStore` and `SharedStore` with latency (via `DECISION` events) and skew. *Depends on RS-7, RS-8, RS-11.*
  - *AC:* with the local store, the effective limit measures approximately N x L.
- **RS-14b Queueing-theory validation tests [Day 3]** (0.5h): low-load mean latency approaches mean service time; utilization = arrival rate x mean service time / slots; Little's law. Fixed seeds and tolerance bands. *Depends on RS-5, RS-6.*

**Day 1 checkpoint:** a script prints comparable stats for the core limiters on the same traffic, and one scenario draws a raw SVG line chart in the browser.

## Epic 3: Runner and UI
- **RS-15 Scenario schema + Runner [Core]** (1.5h): builds N engines from a `Scenario`, shares the traffic source, advances in lockstep, enforces the per-frame event budget. *Depends on RS-4b, RS-6.*
  - *AC:* pause, resume, reset and speed control work; the shared stream is identical across panels; exceeding the budget slows the sim and shows a notice instead of freezing the tab.
- **RS-16 Time-series chart component [Core]** (2h): hand-drawn SVG showing allowed vs rejected, latency percentiles, queue depth; supports vertical event markers. **First 1h slice (raw polyline for one scenario) is pulled into day 1 as an integration smoke test.**
  - *AC:* renders 10 minutes of sim data at 60fps without lag.
- **RS-17 Panel + layout [Core]** (1h): side-by-side panels and stat cards. *Depends on RS-16.*
- **RS-17b Per-client fairness bars [Stretch]** (0.5h)
- **RS-18 Controls [Core]** (1h): live rate slider, burst button, retry policy dropdown, seed, play/pause; writes into the control timeline. *Depends on RS-4b, RS-15.*
- **RS-18b Load presets and guardrails [Stretch]** (1h): ramp, spike, step presets; greedy-client multiplier; traffic shape selector; speed selector; rate cap warning above about 1,000 rps per panel.

## Epic 4: Scenarios and content
- **RS-19a Two core scenarios [Core]** (1h): boundary burst and retry storm.
  - *AC:* each shows its intended lesson clearly at default settings.
- **RS-20a Short explainer [Core]** (0.5h): a "what you're seeing and why" note and a "what this models / leaves out" note for the two core scenarios.
- **RS-19b Remaining four scenarios [Stretch]** (1.5h): noisy neighbor, burst tolerance, distributed limiter, limiting vs load shedding.
- **RS-20b Full explainers + glossary [Stretch]** (1h): notes for all scenarios and a plain-language definition for every metric (from the Metrics glossary above).

## Epic 5: Ship
- **RS-21 Deploy + README [Core]** (1h): Vercel deploy (static, Hobby plan), `vercel.json` rewrite, README with a GIF, architecture section, fidelity section, URL state (preset + params + seed).
- **RS-29 CI gate [Core]** (0.25h): run the test suite in CI (GitHub Action or Vercel build command) so a failing test blocks deploy.
- **RS-22 Polish [Day 3]** (1h): empty states, responsive layout, default scenario on load.

## Epic 6: Failure diagnosis
- **RS-23 Failure taxonomy + thresholds [Day 3]** (1h): `FailureMode` enum, `Finding`/`Fix` types, tier assignment, threshold constants each with a doc comment.
- **RS-24 Diagnoser engine [Day 3]** (2.5h): rolling-window rule evaluation, warm-up exclusion, baseline p99, two-tier root-cause ranking, dedupe with hysteresis. Ships with four rules: **saturation, retry storm, boundary burst, noisy neighbor**. *Depends on RS-6, RS-12.*
- **RS-25 Diagnosis tests [Day 3]** (1.5h): one triggering and one healthy fixture per core rule, in `tests/`. *Depends on RS-24.*
- **RS-26 Diagnosis UI card + chart markers [Day 3]** (1.5h): label, severity, evidence, why, ranked fixes; vertical marker at `startedAt`. *Depends on RS-16, RS-17, RS-24.*
- **RS-27 "Apply fix and re-run" [Stretch]** (1.5h): applies a `patch` to a cloned panel and starts it beside the original on the same seeded traffic. *Depends on RS-15, RS-26.*
- **RS-28 Remaining diagnosis rules [Stretch]** (2h): queue overflow, limit too loose, limit too tight, distributed over-admit, goodput collapse, each with fixtures. *Depends on RS-24, RS-25.*

---

# Schedule

| Block | Hours | Work |
| --- | --- | --- |
| Day 1 | ~11 | RS-1 to RS-7 (sim core + fixed window), plus the first slice of RS-16 as a raw-chart smoke test |
| Day 2 | ~11.75 | RS-8, RS-11, RS-12, RS-14, RS-15, rest of RS-16, RS-17, RS-18, RS-19a, RS-20a, RS-21, RS-29 |
| Day 3 | ~8 | RS-23 to RS-26 (core diagnosis), RS-14b, RS-22 |
| Stretch | ~11.5 | RS-9, RS-10, RS-13, RS-17b, RS-18b, RS-19b, RS-20b, RS-27, RS-28 |

Days 1 and 2 are long (11 to 12 hours each). If that is not realistic, expect the core to spill into a third day and diagnosis to move to a fourth.

# Cut order if behind

**If day 2 runs over:**
1. Shrink RS-20a to one sentence per scenario inside the scenario config
2. Trim RS-12 to none, immediate and backoff + jitter
3. Ship one scenario (retry storm) instead of two
4. Run tests locally and skip RS-29 until later

**If you want diagnosis in the first deploy:** drop RS-8 (token bucket, -1h) and ship one scenario (-0.5h). That still leaves the core about 2 hours short of fitting diagnosis, so expect day 3 regardless.

**Stretch cut order:** RS-13 (distributed) and its scenario first, then RS-9 (leaky bucket), then RS-17b, then RS-22.

**Minimum shippable product:** the whole [Core] tier. It already includes the live rate slider, the retry-storm and boundary-burst demos, tests in CI, and a public URL.
