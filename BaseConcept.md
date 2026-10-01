# Ratescale: Base Concept

A rate-limiting simulator in the spirit of [Breakscale](https://github.com/xevrion/breakscale), scoped to rate limiting and its surrounding concepts.

**Target:** core build of about 24 hours (two long days), failure diagnosis on day 3, remaining scenarios and rules as stretch. Estimates in this revision are recomputed from the tickets below (the whole plan is about 43 hours). Domain terms (Request, Attempt, Variant, Demand, and so on) are defined in `CONTEXT.md`.

## Pitch

**Run the same seeded traffic through different rate limiters side by side, push the load until something breaks, and get told what broke, why, and how to fix it.**

A fixed layout: traffic generator → limiter → backend with finite capacity, with two or three Variants (limiter + retry configurations) running side by side, each shown in its own panel. No drag-and-drop canvas.

Principles borrowed from Breakscale:
- Every number comes from a real discrete-event simulation. Nothing is faked or animated to look plausible.
- The engine has no UI dependency and can be driven from a script.
- Deterministic: the same seed, config and control timeline replay identically.
- Correctness is covered by invariant tests (Attempt and Request conservation, no NaN, bounds).

## What you are building (in one paragraph)

A teaching tool, not a production limiter. Nothing real is sent over a network. Your code invents fake Requests, pushes their Attempts through your own implementations of the limiting algorithms, and measures what happens. Static diagrams say "token bucket refills at N per second"; this shows *why* fixed window lets through double the limit at a window edge, or how clients retrying rejections and timeouts make an overload worse.

## Definition of done and demo script

**Done means:**
- Deployed on Vercel at a public URL
- Test suite passes in CI before deploy
- README with a GIF, architecture section and a "what this models and leaves out" section

**60-second demo (three things to show):**
1. **Boundary burst** (about 15 s): fixed window vs sliding window on the same Edge Burst traffic (bursts timed to straddle the window reset); the fixed-window Variant admits about 2x the limit within one window-length, the sliding-window Variant does not.
2. **Retry storm** (about 20 s): immediate retry vs backoff with jitter; Offered Load balloons and Goodput collapses in one Variant only.
3. **Diagnosis card** (about 25 s): the app names the failure, shows the evidence numbers, and one click re-runs with the fix. *(Needs the day-3 tickets RS-26 and RS-27. Until then the demo is items 1 and 2 plus dragging the rate slider.)*

## Concepts to cover

### Algorithms (all behind one interface)
- **Fixed window**: shows the boundary-burst flaw (2x the limit across a window edge)
- **Sliding window log**: accurate but memory-heavy
- **Sliding window counter**: the practical approximation
- **Token bucket**: allows bursts
- **Leaky bucket**: smooths output as a bounded queue that Delays Attempts rather than rejecting them (see `docs/adr/0001-leaky-bucket-as-queue.md`)

### Scenarios (each isolates one lesson)
1. **Boundary burst**: fixed window vs sliding window under Edge Burst traffic *(core)*
2. **Retry storm**: immediate retry vs exponential backoff with jitter *(core)*
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
│   builds one Engine per Variant, advances them in lockstep,               │
│   enforces the per-frame event budget                                     │
└───────────────▲───────────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────── Sim Engine (src/sim, no React/DOM) ───────────┐
│                                                                           │
│  Shared TrafficSource ──arrivals──▶ Client(s) attempt▶ Limiter ──▶ Backend│
│  (lazy, rate from            (retry/backoff,     (algo, keyBy)  (slots +  │
│   control timeline)           timeout)   ▲              │        FIFO q)  │
│                                          └──── 429 ◀────┘  ◀─ response ─┘ │
│                                                                           │
│  EventQueue (min-heap) · SimClock · SeededRNG · MetricsCollector          │
│  Diagnoser (rules over snapshot history → Findings)                       │
└───────────────────────────────────────────────────────────────────────────┘
```

## Key design decisions

1. **Discrete-event simulation.** A min-heap event queue ordered by simulated time, with a sequence-number tiebreaker so equal timestamps always pop in insertion order. Events: `ARRIVAL`, `DECISION`, `RELEASE`, `SERVICE_END`, `RETRY`, `TIMEOUT`, `SAMPLE`. The engine advances by popping events up to `now + dt`, so the UI can run at any speed.
2. **Lazy shared traffic source (supports live load control).** One `TrafficSource` generates arrivals just ahead of the simulated clock using the *current* rate, appending to a shared log that every Variant's engine reads. All Variants still see identical traffic, so the comparison stays fair. Poisson inter-arrivals are memoryless, so changing the rate mid-run is statistically correct. Each Variant's engine owns its own retry state, limiter, backend and metrics, because retries depend on responses and diverge per Variant. A Scenario can also supply **scripted arrivals** (bursts at exact times), which are merged into the shared log; this is how Edge Burst traffic is produced.
3. **Control timeline for determinism.** Every control change is recorded as `{ atMs, change }`. Seed + control timeline replays a run exactly, including slider moves, so a run can be exported or used as a test fixture. Changes apply at the current sim time, never retroactively.
4. **Limiter is a deterministic, time-injected strategy.** `decide(clientId, now) -> Allow | Reject { retryAfterMs? } | Delay { releaseAtMs }`. It holds per-key state, but it never reads the clock or RNG itself, only the `now` it is given. That makes it fully replayable and easy to test. `LimiterSpec.keyBy` decides whether state is one global bucket or one per client.
5. **Store latency is modeled with a `DECISION` event.** On `ARRIVAL`, the engine schedules `DECISION` at `now + storeLatency` (zero for local stores, handled inline) and calls `decide()` when it fires. `decide()` itself stays synchronous.
6. **Distributed limiting is a wrapper, not a special case.** N `LimiterNode`s, each with a `CounterStore`. `LocalStore` = per-node counters (effective limit N x L). `SharedStore` = one counter with configurable latency and optional clock skew.
7. **Backend is a finite-slot server; Attempts time out.** Capacity slots plus a FIFO queue with a limit, gamma-distributed service times (`shape = 1/cv^2`, `scale = mean * cv^2`). Each Attempt times out after `timeoutMs` (a `TIMEOUT` event) and the Retry Policy may retry it. An abandoned Attempt still occupies backend capacity until it finishes (**Wasted Work**) and its late response is discarded, which is what makes goodput collapse possible.
8. **Metrics are measured.** Counters bucketed per second, latency percentiles from ring buffers of Attempt and end-to-end latencies, and allowed-Attempt counts at sub-window resolution (see Metrics glossary). The first 5 simulated seconds are a **warm-up** and are excluded from diagnosis.
9. **Diagnosis is computed, not scripted.** Rule-based findings derived from measured metrics, each carrying its evidence (see below).
10. **Determinism.** Seeded RNG (mulberry32) and the simulated clock only. Separate RNG streams for traffic, service times and retry jitter, so adding a draw in one place does not shift the others. Never `Date.now()` or `Math.random()` inside the engine.
11. **Leaky bucket is a queue, not a meter.** A meter-style leaky bucket is identical to a token bucket, so it would teach nothing beside one. The Limiter can therefore answer `Delay`; the engine holds the Attempt until a `RELEASE` event at `releaseAtMs`. The leaky queue is bounded (full means Reject), and the Attempt's timeout keeps running while it waits. See ADR 0001.
12. **Retries cover every failed Attempt.** The Retry Policy fires after a Reject, a timeout or a Shed, as real clients retry 429, timeouts and 503. `Retry-After` applies only to Rejects.

## Load control

**Live, while running:**
- Demand slider (new Requests per second, before retries)
- Greedy-client multiplier (one client sends N x the others; drives noisy-neighbor)
- Burst button (e.g. 5x rate for 2 seconds on demand)
- Traffic shape: constant, Poisson, or bursty on/off
- Simulation speed: 0.5x, 1x, 10x
- One-click load presets: **ramp** (10 to 500 rps over a minute), **spike**, **step**

**Before or between runs:**
- Limiter settings (algorithm, key scope, limit, window, bucket size, refill rate, leaky queue limit)
- Backend capacity (slots, queue limit, mean service time, cv)
- Retry Policy (per-Attempt timeout, retry mode, max attempts, base delay)
- Seed

**Guardrails:** cap at roughly 1,000 rps per Variant and show a warning above that; the runner also enforces an events-per-frame budget (see Performance).

## Failure diagnosis ("what broke, why, how to fix")

A `Diagnoser` in `src/sim/` reads the snapshot history once per simulated second on a rolling window and returns findings. Every finding is derived from measured values with explicit thresholds; nothing is hardcoded per scenario. The first 5 s (warm-up) are ignored.

```ts
interface Finding {
  id: FailureMode;                                // e.g. 'retry-storm'
  label: string;                                  // "Retry storm"
  kind: 'cause' | 'symptom';                      // fixed per FailureMode
  severity: 'warn' | 'broken';
  startedAt: number;                              // sim time it first triggered
  evidence: { metric: string; value: string }[];  // numbers that fired the rule
  why: string;                                    // template filled from evidence
  fixes: Fix[];                                   // ranked suggestions
  role: 'root-cause' | 'contributing';            // exactly one root cause per diagnosis
}

interface Fix {
  text: string;
  patch?: Partial<VariantConfig>;                   // optional: one-click "apply and re-run"
}
```

### Detection rules

"Baseline p99" means the **theoretical p99 of the backend's service-time distribution** (computable from mean and cv), so it is well defined even when a scenario starts overloaded.

| Failure mode | Kind | Fires when | Why (template) | Typical fixes |
| --- | --- | --- | --- | --- |
| Retry storm | Cause | Retry Amplification (Offered Load / Demand) > 1.5 | Clients retry rejected, timed-out and shed Attempts with no backoff, so every failure creates more traffic than it removes | Exponential backoff + jitter, honor `Retry-After`, cap attempts |
| Boundary burst | Cause | fixed-window limiter; allowed Attempts in any span of one window-length (checked at window/10 resolution) exceed the limit by > 30% | Counter resets at the window edge, so a client can use two windows' worth back to back | Switch to sliding window or token bucket |
| Noisy neighbor | Cause | one client holds > 50% of allowed traffic while others' allow rate drops | A global limit is first-come-first-served, so a heavy client crowds out the rest | Per-client limits, weighted fair queuing |
| Distributed over-admit | Cause | effective allowed rate > 1.3x configured limit, local stores, N > 1 | Each node counts on its own, so the real limit is about N x limit | Shared counter, or divide the limit by N |
| Limit too loose | Cause | limiter rejects ~0 but backend is saturated | Limit is above what the backend can serve, so the limiter protects nothing | Set limit <= backend capacity x safety factor |
| Limit too tight | Cause | backend utilization < 40% while rejection rate > 30% | Legitimate traffic is rejected while capacity sits idle | Raise the limit, add burst allowance |
| Backend saturation | Symptom | utilization >= 95% and p99 > 3x baseline p99 | Arrival rate is near or above capacity, so the queue grows and latency explodes | Lower the limit, add slots, add a cache |
| Queue overflow / load shedding | Symptom | over the last 5 s, Attempts shed or timed out are >= 1% of those sent to the Backend (`warn`), >= 5% (`broken`); left below half of each (built early, 2026-10-01: `src/sim/diagnosis.ts`) | Queue hit its limit, so Attempts are shed | Smaller limiter limit, bigger queue (with latency warning), autoscale |
| Goodput collapse | Symptom | Goodput < 50% of its own peak while backend utilization stays high | Backend is busy on Wasted Work: Attempts callers already abandoned | Shorter queue, timeouts and cancellation, shed earlier |

### Ranking and behavior
- **Causes before Symptoms, one Root Cause.** Each Failure Mode is a Cause or a Symptom. Among Causes, the earliest `startedAt` is the Root Cause. If no Cause fires, the earliest Symptom is the Root Cause. Every other Finding is Contributing. Symptoms are listed in the fixed order saturation → queue overflow → goodput collapse. The timestamps are shown as evidence, so a reader can see when they disagree with the ordering.
- A finding fires once and clears with hysteresis to avoid flicker.
- Fixes are phrased as "try", not "will", because they are suggestions for this simulated system.

### What the user sees
When the first `broken` finding appears: a vertical marker on the chart at `startedAt`; a card with the label, severity and evidence numbers; a **Why** text built from a template plus actual values (e.g. "Offered Load reached 2.4x Demand because 71% of rejected Attempts were retried within 100 ms"); ranked **How to fix** options, each with **Apply and re-run** when a `patch` exists. Applying a fix creates a new Variant that runs from t=0 in a panel beside the original, on the same seeded traffic, so the improvement is visible.

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
| Demand | New Requests per second, before retries (what the rate slider sets) |
| Offered load | Attempts per second reaching the limiter, **including retries** |
| Retry amplification | Offered load / Demand |
| Allowed / rejected / delayed | Limiter Decisions per second, counted per Attempt |
| Rejection rate | rejected / (allowed + rejected + delayed) |
| Throughput | Attempts the backend completes per second (including Wasted Work) |
| Goodput | Requests that Succeeded, per second |
| Wasted work | Backend time spent on Attempts that had already timed out; their responses are discarded |
| Attempt latency | Completion time minus the time the Attempt reached the limiter, including delay and queue wait. Only Attempts that got a response before timing out; timed-out Attempts show up in timeouts and Goodput instead |
| End-to-end latency | Time from a Request's first Attempt to its success, across all retries (Succeeded Requests only) |
| p50 / p95 / p99 | Percentiles over Attempt latency (and, separately, end-to-end latency) in a rolling window |
| Baseline p99 | Theoretical p99 of the service-time distribution (from mean and cv) |
| Utilization | Time-averaged fraction of busy backend slots, in [0, 1] |
| Queue depth | Attempts waiting for a backend slot at sample time |
| Shed | Attempts dropped because the backend queue was full |
| Failed | Requests that ended Rejected, Timed out or Shed |
| Warm-up | First 5 simulated seconds, excluded from diagnosis and baselines |
| Sub-bucket counts | Allowed-Attempt counts at window/10 resolution, used for boundary-burst detection |

## Core types

```ts
type ClientId = string;

type RequestId = number;

interface Attempt {
  requestId: RequestId;
  clientId: ClientId;
  attemptNo: number;               // 1 for the first Attempt of a Request
  startedAt: number;               // when this Attempt reached the limiter
}

type LimiterDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; retryAfterMs?: number }
  | { kind: 'delay'; releaseAtMs: number };   // leaky bucket only (ADR 0001)

interface Limiter {
  decide(id: ClientId, now: number): LimiterDecision;
  reset(): void;
}

interface LimiterSpec {
  algo: 'fixed-window' | 'sliding-log' | 'sliding-counter' | 'token-bucket' | 'leaky-bucket';
  keyBy: 'global' | 'client';      // one shared bucket, or one per client
  limit: number;
  windowMs?: number;               // window algorithms
  capacity?: number;               // bucket algorithms
  refillPerSec?: number;
  queueLimit?: number;             // leaky bucket: max Delayed Attempts; full = reject
}

// Retries after a Reject, a timeout or a Shed. One policy per Variant.
// A union on `retry`, like LimiterSpec: only the modes that wait have a base delay.
type RetryPolicy =
  | { timeoutMs: number; maxAttempts: number; retry: 'none' | 'immediate' }
  | {
      timeoutMs: number;           // per Attempt
      maxAttempts: number;
      retry: 'backoff' | 'backoff-jitter' | 'retry-after';
      baseDelayMs: number;         // first retry's backoff; doubles per Attempt; full jitter
    };

interface ControlEvent {
  atMs: number;
  change:
    | { kind: 'demand'; demandRps: number }
    | { kind: 'greedyMultiplier'; clientId: ClientId; multiplier: number }
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
  traffic: TrafficSpec;      // one spec; its clients and greedy describe several Clients
  controls?: ControlEvent[]; // scripted load (ramp, spike, step)
  scriptedArrivals?: { atMs: number; count: number; clientId?: ClientId }[]; // e.g. Edge Burst
  backend: { slots: number; queueLimit: number; meanMs: number; cv: number };
  variants: VariantConfig[];
}

interface VariantConfig {
  label: string;
  limiter: LimiterSpec;
  retry: RetryPolicy;
  // RS-13 (stretch) adds: nodes?: number; store?: 'local' | 'shared'; storeLatencyMs?: number
}

interface Snapshot {
  t: number;                 // end of the second it covers: [t - 1000, t)
  warmUp: boolean;           // t <= 5000, left out of diagnosis (D4)
  demand: number;            // new Requests
  offeredLoad: number;       // Attempts, retries included
  allowed: number;
  rejected: number;
  delayed: number;
  goodput: number;           // Succeeded Requests
  failed: { rejected: number; timedOut: number; shed: number };  // Requests
  wastedWorkMs: number;
  backendUtil: number;
  queueDepth: number;
  shed: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;        // Attempt latency percentiles over the last 5 s; null (a dash) when none completed
  e2eP50: number | null;
  e2eP95: number | null;
  e2eP99: number | null;     // end-to-end, Succeeded Requests only
  perClient: Record<ClientId, { offeredLoad: number; allowed: number }>;
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
- **ARRIVAL:** a new Request makes its first Attempt. Schedule `DECISION` at `now + storeLatency` (inline when zero) and `TIMEOUT` at `now + timeoutMs`.
- **DECISION:** ask the limiter. Allow goes to the backend. Reject is recorded and the Retry Policy decides whether to schedule a `RETRY` (honoring `retryAfterMs` when the policy says so). Delay schedules `RELEASE` at `releaseAtMs`.
- **RELEASE:** a Delayed Attempt goes to the backend, unless it has already timed out.
- **RETRY:** a new Attempt of the same Request, with `attemptNo + 1` so backoff grows. It gets its own `TIMEOUT`.
- **TIMEOUT:** if the Attempt has not completed, it is abandoned and the Retry Policy decides whether to retry. Backend work already started still runs to completion as Wasted Work. The Request fails as Timed out only when no retry follows.
- **SERVICE_END:** free a slot and pull the next Attempt off the FIFO queue. If the Attempt was abandoned, count Wasted Work and discard the response; otherwise record latency and complete the Request as Succeeded.
- **Backend submit:** free slot means start; otherwise queue if under the limit; otherwise shed, and the Retry Policy decides whether to retry.
- **React wiring:** engines live in a `useRef` (they mutate constantly); a `requestAnimationFrame` loop calls `advance(dt * speed)` on every Variant's engine; snapshots copy into React state at about 30 fps; charts are SVG polylines from the history arrays.
- **Build order:** walking skeleton first (RNG, clock, heap, then one constant source through fixed window to the backend, `console.log` the snapshot). Then wire **one scenario to a raw SVG polyline before the end of day 1** so integration problems (the animation-frame loop, snapshot shape) surface while they are cheap. Then add the remaining limiters, traffic types and retry policies.

## Performance

- **Events-per-frame budget** in the runner (start around 20,000 events per frame). If exceeded, the simulation slows below the requested speed and the UI shows "running slower than requested." Retries can multiply event counts at high speed and rate, so the budget is what keeps the browser responsive.
- **Worker-ready engine:** no DOM, timers or global state inside `src/sim/`, and snapshots are plain serializable objects, so the engine can move into a Web Worker later without a rewrite. Start on the main thread.
- Rate cap of about 1,000 rps per Variant with a UI warning above it.

## Testing strategy

- Conservation, for Attempts: reached limiter = allowed + rejected + delayed. For Requests: created = succeeded + failed + in-flight
- No client exceeds the configured limit over any window (except where the algorithm is supposed to, e.g. fixed window at the boundary)
- Failure breakdown (rejected + timed out + shed) sums to failed
- Utilization stays within [0, 1]; neither the backend queue nor the leaky queue exceeds its limit
- No snapshot field is ever NaN or Infinity
- Same seed + control timeline produces an identical run
- Queueing-theory checks on the backend (see Fidelity), including Little's law
- Diagnoser: one triggering fixture and one healthy fixture per rule (e.g. retry-storm scenario yields `retry-storm`; a balanced scenario yields no findings). Fixtures live in tests, not only in scenario presets.
- **Statistical tests are not flaky by construction:** fixed seeds, long enough runs, and explicit tolerance bands (e.g. Poisson mean within 3% over 60 simulated seconds); never a fresh random seed per run.
- CI runs the whole suite on every push and gates the deploy.

## Decisions log

| # | Decision | Status |
| --- | --- | --- |
| D1 | Shared-store latency is modeled with a `DECISION` event at `now + storeLatency`; `decide()` stays synchronous | Decided (implement in RS-6, used by RS-13) |
| D2 | `LimiterSpec.keyBy: 'global' \| 'client'` decides bucket scope | Decided (RS-7) |
| D3 | `RetryPolicy.timeoutMs` (per Attempt) and a `TIMEOUT` event; abandoned work still burns backend capacity | Decided (RS-6, RS-12) |
| D4 | Baseline p99 = theoretical service-time p99; first 5 s are warm-up and excluded from diagnosis | Decided (RS-6, RS-24) |
| D5 | Boundary-burst detection uses allowed-Attempt counts at window/10 resolution | Decided (RS-6, RS-24) |
| D6 | Diagnosis ranking: Causes before Symptoms, fixed order among Symptoms, earliest Cause is the one Root Cause, all others Contributing | Decided (RS-24) |
| D7 | URL stores preset + params + seed; slider moves coalesced; long runs export as JSON | Decided (RS-21) |
| D8 | Engine runs on the main thread first; move to a Web Worker only if the event budget is hit in practice | Open |
| D9 | Report end-to-end latency across retries (Succeeded Requests only) alongside Attempt latency | Decided (RS-6, RS-12) |
| D10 | Leaky bucket is a bounded queue; the Limiter can answer Delay. The interface and `RELEASE` handling ship in Core even though leaky bucket is Stretch (ADR 0001) | Decided (RS-7, RS-9) |
| D11 | Timeout is per Attempt. The Retry Policy retries after Reject, timeout and Shed; late responses are discarded as Wasted Work | Decided (RS-5, RS-12) |
| D12 | Edge Burst traffic comes from scripted arrivals in the Scenario, merged into the shared traffic log | Decided (RS-19a) |
| D13 | Domain vocabulary (Request/Attempt, Variant, Demand, Cause/Symptom, and so on) lives in `CONTEXT.md` | Decided |

---

# Tickets

Every ticket is tagged **[Core]** (days 1 and 2, about 24 hours), **[Day 3]** (about 8 hours) or **[Stretch]** (about 11.5 hours). Whole plan: about 43 hours. Ordered by dependency.

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
- **RS-4b Lazy shared TrafficSource + control timeline [Core]** (1.5h): generates arrivals just ahead of the sim clock at the current rate, appends to one shared log read by every Variant, records every control change as `{ atMs, change }`. *Depends on RS-2, RS-4.*
  - *AC:* changing the rate mid-run gives the correct new mean rate afterward; all Variants see identical arrivals; seed + control timeline replays identically.
- **RS-5 Backend model [Core]** (2h): slots, FIFO queue, queue-limit shedding, gamma service time, abandoned work keeps burning capacity. *Depends on RS-2, RS-3.*
  - *AC:* utilization is <= 1 and queue never exceeds the limit.
- **RS-6 Engine loop + Metrics collector [Core]** (2h): `ARRIVAL`, `DECISION`, `SERVICE_END`, `RETRY`, `TIMEOUT`, `SAMPLE` events; produces `Snapshot`; tracks each Request across its Attempts; records Attempt and end-to-end latency ring buffers, warm-up flag, and allowed counts at window/10 resolution. *Depends on RS-3 to RS-5.*
  - *AC:* Attempt and Request conservation hold; warm-up seconds are flagged; sub-bucket counts sum to the allowed total.
  - *Note (2026-09-30):* Demand in the Snapshot is counted from new Requests actually generated (bursts and scripted arrivals included), not read from the slider, so Retry Amplification stays true during a burst. See `.scratch/traffic/spec.md` decision 7.

## Epic 2: Limiters and client behavior
- **RS-7 Limiter interface + Fixed Window [Core]** (1.5h): includes `keyBy` scope and the three-way Limiter Decision (Allow, Reject, Delay) with the engine's `RELEASE` handling, so leaky bucket can be added later without changing the interface (D10).
  - *AC:* boundary and reset tests; an explicit test showing about 2x the limit across a window edge; global and per-client scope both work; a stub limiter that returns Delay releases Attempts at `releaseAtMs`.
- **RS-8 Token Bucket [Core]** (1h)
  - *AC:* lazy-refill tests, burst up to capacity, `retryAfterMs` correct.
- **RS-11 Sliding Window Counter [Core]** (1h)
  - *AC:* does not admit 2x the limit across a boundary in the same scenario where fixed window does.
- **RS-12 Retry policies + timeout [Core]** (1.5h): none, immediate, exponential backoff, backoff plus jitter, `Retry-After`-honoring; per-Attempt `timeoutMs` and `maxAttempts`; retries after Reject, timeout and Shed; late responses discarded (D11). *Depends on RS-6.*
  - *AC:* after a burst into a Limiter, immediate retries end Rejected while backoff + jitter lets them Succeed (Goodput); a Backend whose full queue waits longer than the timeout stays collapsed with retries (either policy) and recovers without; a Request counts as Timed out only when its last Attempt timed out and no retry followed.
  - *Note (2026-10-01):* the original AC ("raises Retry Amplification with immediate retry and not with backoff + jitter") is false in this model and was changed with the human. A Request that keeps failing uses all its Attempts whatever the wait, so backoff spreads retries out but does not remove them; it wins on Goodput. See `.scratch/retry/spec.md` decision 10 and `tests/retry-storm.test.ts`.
- **RS-14 Invariant test suite [Core]** (1h): no NaN or Infinity, failure breakdown sums to total, same seed + timeline gives an identical run. *Depends on RS-6.*
- **RS-9 Leaky Bucket [Stretch]** (1h): bounded queue using the Delay decision; a full queue rejects (ADR 0001).
- **RS-10 Sliding Window Log [Stretch]** (1h)
  - *AC for RS-9 and RS-10:* same shape of tests as the other limiters; Sliding Log never exceeds the limit in any window; leaky bucket releases at a steady rate and never holds more than `queueLimit`.
- **RS-13 Distributed wrapper [Stretch]** (2h): N nodes, `LocalStore` and `SharedStore` with latency (via `DECISION` events) and skew. *Depends on RS-7, RS-8, RS-11.*
  - *AC:* with the local store, the effective limit measures approximately N x L.
- **RS-14b Queueing-theory validation tests [Day 3]** (0.5h): low-load mean latency approaches mean service time; utilization = arrival rate x mean service time / slots; Little's law. Fixed seeds and tolerance bands. *Depends on RS-5, RS-6.*

**Day 1 checkpoint:** a script prints comparable stats for the core limiters (one Variant each) on the same traffic, and one scenario draws a raw SVG line chart in the browser.

## Epic 3: Runner and UI
- **RS-15 Scenario schema + Runner [Core]** (1.5h): builds one engine per Variant of a `Scenario`, shares the traffic source (including scripted arrivals), advances in lockstep, enforces the per-frame event budget. *Depends on RS-4b, RS-6.*
  - *Note (2026-10-01):* `Scenario.traffic` is one `TrafficSpec`, and `VariantConfig` leaves out the distributed fields until RS-13 (`.scratch/runner/spec.md` decisions 3 and 4). Measured at 1,000 rps with three Variants: about 870,000 events per second of wall time under Bun, so 10x speed at 60 fps needs about 1,800 events, 2 ms, per frame. A budget of 20,000 events would be about 23 ms at that rate, longer than one 16.7 ms frame, so the default is 12,000, about 14 ms (ticket 04 of `.scratch/runner/`). Browser speed is measured in RS-16.
  - *AC:* pause, resume, reset and speed control work; the shared stream is identical across Variants; exceeding the budget slows the sim and shows a notice instead of freezing the tab.
- **RS-16 Time-series chart component [Core]** (2h): hand-drawn SVG showing allowed vs rejected, latency percentiles, queue depth; supports vertical event markers. **First 1h slice (raw polyline for one scenario) is pulled into day 1 as an integration smoke test.**
  - *AC:* renders 10 minutes of sim data at 60fps without lag.
- **RS-17 Panel + layout [Core]** (1h): side-by-side panels and stat cards. *Depends on RS-16.*
- **RS-17b Per-client fairness bars [Stretch]** (0.5h)
- **RS-18 Controls [Core]** (1h): live Demand slider, burst button, retry policy dropdown, seed, play/pause; writes into the control timeline. *Depends on RS-4b, RS-15.*
- **RS-18b Load presets and guardrails [Stretch]** (1h): ramp, spike, step presets; greedy-client multiplier; traffic shape selector; speed selector; rate cap warning above about 1,000 rps per Variant.

## Epic 4: Scenarios and content
- **RS-19a Two core scenarios [Core]** (1.5h): boundary burst (with scripted Edge Burst arrivals timed to the window edge, D12) and retry storm.
  - *AC:* each shows its intended lesson clearly at default settings.
  - *Note (2026-10-01):* measured in RS-12, immediate retry vs backoff + jitter does not make "Goodput collapse in one Variant only": once a Backend's full queue waits longer than the timeout, both stay collapsed after the overload ends, and only no retry (or fewer Attempts, or a shorter queue) recovers. Redesign the retry-storm Variants from `tests/retry-storm.test.ts` before building it.
- **RS-20a Short explainer [Core]** (0.5h): a "what you're seeing and why" note and a "what this models / leaves out" note for the two core scenarios.
- **RS-19b Remaining four scenarios [Stretch]** (1.5h): noisy neighbor, burst tolerance, distributed limiter, limiting vs load shedding.
- **RS-20b Full explainers + glossary [Stretch]** (1h): notes for all scenarios and a plain-language definition for every metric (from the Metrics glossary above).

## Epic 5: Ship
- **RS-21 Deploy + README [Core]** (1h): Vercel deploy (static, Hobby plan), `vercel.json` rewrite, README with a GIF, architecture section, fidelity section, URL state (preset + params + seed).
- **RS-29 CI gate [Core]** (0.25h): run the test suite in CI (GitHub Action or Vercel build command) so a failing test blocks deploy.
- **RS-22 Polish [Day 3]** (1h): empty states, responsive layout, default scenario on load.

## Epic 6: Failure diagnosis
- **RS-23 Failure taxonomy + thresholds [Day 3]** (1h): `FailureMode` enum, `Finding`/`Fix` types, Cause/Symptom assignment, threshold constants each with a doc comment.
- **RS-24 Diagnoser engine [Day 3]** (2.5h): rolling-window rule evaluation, warm-up exclusion, baseline p99, Root Cause ranking (Causes before Symptoms), dedupe with hysteresis. Ships with four rules: **saturation, retry storm, boundary burst, noisy neighbor**. *Depends on RS-6, RS-12.*
- **RS-25 Diagnosis tests [Day 3]** (1.5h): one triggering and one healthy fixture per core rule, in `tests/`. *Depends on RS-24.*
- **RS-26 Diagnosis UI card + chart markers [Day 3]** (1.5h): label, severity, evidence, why, ranked fixes; vertical marker at `startedAt`. *Depends on RS-16, RS-17, RS-24.*
- **RS-27 "Apply fix and re-run" [Stretch]** (1.5h): applies a `patch` to create a new Variant and starts it from t=0 beside the original on the same seeded traffic. *Depends on RS-15, RS-26.*
- **RS-28 Remaining diagnosis rules [Stretch]** (2h): limit too loose, limit too tight, distributed over-admit, goodput collapse, each with fixtures. *Depends on RS-24, RS-25.*
  - *Note (2026-10-01):* queue overflow was built early, with the Backend overload Scenario (`.scratch/backend-overload/`). "Shed count > 0" fired on a healthy fixed window at its calm default (9 shed in 2 minutes), so the rule is a share with thresholds instead.

---

# Schedule

| Block | Hours | Work |
| --- | --- | --- |
| Day 1 | ~11.5 | RS-1 to RS-7 (sim core + fixed window), plus the first slice of RS-16 as a raw-chart smoke test |
| Day 2 | ~12.25 | RS-8, RS-11, RS-12, RS-14, RS-15, rest of RS-16, RS-17, RS-18, RS-19a, RS-20a, RS-21, RS-29 |
| Day 3 | ~8 | RS-23 to RS-26 (core diagnosis), RS-14b, RS-22 |
| Stretch | ~11.5 | RS-9, RS-10, RS-13, RS-17b, RS-18b, RS-19b, RS-20b, RS-27, RS-28 |

Days 1 and 2 are long (11.5 to 12.25 hours each). If that is not realistic, expect the core to spill into a third day and diagnosis to move to a fourth.

# Cut order if behind

**If day 2 runs over:**
1. Shrink RS-20a to one sentence per scenario inside the scenario config
2. Trim RS-12 to none, immediate and backoff + jitter
3. Ship one scenario (retry storm) instead of two
4. Run tests locally and skip RS-29 until later

**If you want diagnosis in the first deploy:** drop RS-8 (token bucket, -1h) and ship one scenario (-0.5h). That still leaves the core about 2 hours short of fitting diagnosis, so expect day 3 regardless.

**Stretch cut order:** RS-13 (distributed) and its scenario first, then RS-9 (leaky bucket), then RS-17b, then RS-22.

**Minimum shippable product:** the whole [Core] tier. It already includes the live rate slider, the retry-storm and boundary-burst demos, tests in CI, and a public URL.
