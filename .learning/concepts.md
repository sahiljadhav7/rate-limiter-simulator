# Concepts behind Ratescale

[`features.md`](features.md) says *what* each feature does. This file says *which ideas* you need to understand to build it, and where each one shows up in the code. Each concept follows the same pattern: the idea in plain words, how this project uses it, and a question to answer from memory.

Read one section, close the file, and try its question before opening the answer. Come back in a few days and try again. Recalling after a gap is what makes it stick.

> Ask your agent about anything unclear. A good way to use it: "quiz me on section 3", or "show me this concept in the code".

**Sections**
1. [Simulation concepts](#1-simulation-concepts)
2. [Probability and statistics](#2-probability-and-statistics)
3. [Queueing and capacity](#3-queueing-and-capacity)
4. [Rate limiting algorithms](#4-rate-limiting-algorithms)
5. [Reliability: retries, overload and failure](#5-reliability-retries-overload-and-failure)
6. [Diagnosis as software design](#6-diagnosis-as-software-design)
7. [Software design principles](#7-software-design-principles)
8. [Testing concepts](#8-testing-concepts)
9. [Frontend concepts](#9-frontend-concepts)
10. [Tooling and deployment](#10-tooling-and-deployment)
11. [Concept map](#11-concept-map)

---

## 1. Simulation concepts

### 1.1 Discrete-event simulation
**The idea.** Instead of moving time forward a tiny step at a time, you jump from one *event* to the next. Between events nothing changes, so there is nothing to compute. An event might be "a request arrives", "a service finishes" or "a timeout fires".

**In Ratescale.** The engine loop in [`engine.ts`](../src/sim/engine.ts) (`advanceTo`) looks at the next scheduled event and the next arrival, takes the earlier one, moves the clock to its time, and handles it. Five event kinds exist: `serviceEnd`, `retry`, `timeout`, `decision`, `release`.

**Why it matters.** Ten simulated minutes at 1,000 requests per second would be 600,000 steps of 1 ms. Jumping between events does work only when something happens, so it is faster and exact to the millisecond.

**Recall:** Why does the engine not simply loop "for each millisecond"?

### 1.2 Simulated time vs wall time
**The idea.** *Wall time* is the real clock. *Simulated time* is a number the program owns. They only meet where the user watches the run.

**In Ratescale.** Code in `src/sim` and `src/runner` may never call `Date.now()`, `Math.random()`, `setTimeout` or `requestAnimationFrame`. A test ([`tests/sim-boundary.test.ts`](../tests/sim-boundary.test.ts)) scans those folders and fails the build on any of them. Only the UI frame loop ([`use-runner.ts`](../src/ui/use-runner.ts)) reads wall time, and it passes the elapsed milliseconds into `runner.tick(wallMs)`.

**Recall:** Where is the one place wall-clock time enters the system, and what does it become?

### 1.3 Determinism and replay
**The idea.** A program is deterministic when the same inputs always give the same outputs. For a simulation, the inputs are the starting configuration, the random seed, and any user actions with their times.

**In Ratescale.** Seed plus the *control timeline* (every Demand change and burst, with its simulated time) replays a run exactly. This is how the Share link works, and it is what makes statistical tests reliable. Determinism breaks quietly: one stray `Math.random()` produces no error, only runs that drift.

**Recall:** Name two things that would make two runs of the same seed differ.

### 1.4 Priority queue (binary min-heap) and tie-breaking
**The idea.** A priority queue always hands back the smallest item. A *binary heap* does this in O(log n) per push and pop. When two events share the same time, you need a rule for which goes first, or the order depends on implementation details.

**In Ratescale.** [`event-queue.ts`](../src/sim/event-queue.ts) is a min-heap keyed by time, then by a *sequence number* assigned at push. Equal-time events pop in insertion order. It also rejects `NaN` times, because `NaN` compares false to everything and would corrupt the ordering silently.

**Recall:** Why is "time, then sequence number" better than just "time"?

### 1.5 Lockstep advance and chunk invariance
**The idea.** To compare variants fairly, all of them must be at the same moment. And the result should not depend on how you slice time: running 1 second as one step or as twenty steps of 50 ms must give the same answer.

**In Ratescale.** The runner moves the shared traffic first, then each engine, in 50 ms sub-steps ([`runner.ts`](../src/runner/runner.ts)). Traffic is generated exactly up to the requested time and never ahead, so frame timing can never change the arrivals.

**Recall:** Why does generating traffic "ahead" per frame make replays depend on frame timing?

### 1.6 Backpressure on the simulator itself (event budget)
**The idea.** If the work per frame can grow without limit, a slow frame makes the next one slower still. A budget caps work per frame and lets the program run slower than asked instead of freezing.

**In Ratescale.** `DEFAULT_EVENT_BUDGET = 12_000` events per frame; the footer shows "running slower than requested" when it is hit. `FRAME_CAP_MS = 100` also stops a long pause (a returning background tab) from jumping the run ahead by seconds.

---

## 2. Probability and statistics

### 2.1 Pseudo-random number generators (PRNG) and seeds
**The idea.** A PRNG produces numbers that look random but are completely determined by a starting *seed*. Same seed, same sequence.

**In Ratescale.** [`rng.ts`](../src/sim/rng.ts) uses **mulberry32**: a tiny generator with 32 bits of state, easy to replay from one number. It returns floats in [0, 1). Seeds must be whole numbers from 0 to 2³²−1; bad seeds are rejected rather than rounded, because rounding would quietly map different seeds to the same run.

### 2.2 Independent streams
**The idea.** If several parts of a program share one random sequence, adding a draw in one part shifts every later value in the others. Give each part its own stream.

**In Ratescale.** Three streams: `traffic`, `service`, `jitter`. Each is seeded by `fmix32(rootSeed XOR fnv1a32(name))`. FNV-1a hashes the name into a fixed tag; `fmix32` (from MurmurHash3) scrambles so that nearby seeds do not give shifted copies of each other.

**Recall:** What goes wrong if retry jitter draws from the traffic stream?
<details><summary>Answer</summary>Turning retries on changes how many numbers the traffic stream has used, so every later arrival moves. The two Variants would no longer see the same traffic, and the comparison would be unfair.</details>

### 2.3 Poisson arrivals and the exponential distribution
**The idea.** Many independent callers produce arrivals that look like a *Poisson process*: events at a steady average rate, but at random moments. The gaps between arrivals follow an *exponential distribution*. Random gaps mean traffic naturally clumps and thins out.

**In Ratescale.** [`traffic.ts`](../src/sim/traffic.ts) draws `-ln(1 - u)` for each gap (a *unit exponential*, mean 1), then converts it to time by dividing by the rate. Using `1 - u` instead of `u` keeps the logarithm finite, because `u` can be 0 but never 1.

### 2.4 Inverse transform sampling
**The idea.** To draw from a distribution with a known cumulative curve, feed a uniform random number through the inverse of that curve. For the exponential distribution the inverse is `-ln(1 - u)`.

**In Ratescale.** That one line in `unitExponential` is the whole technique.

### 2.5 Work vs rate (a design trick)
**The idea.** The code draws each gap as an amount of *work* in expected arrivals, and consumes it against the current rate over time. The next arrival happens where the integrated rate reaches the work.

**Why.** If the student moves the Demand slider in the middle of a gap, the gap rescales without a new random draw. A new draw would change the random sequence and break replay.

### 2.6 Bursty traffic and the mean
**The idea.** *Bursty* traffic is on for a while, then off. If it is on for 1 s and off for 4 s, the rate while on is 5× the long-run average.

**In Ratescale.** Backend overload uses on 1 s, off 4 s. At a Demand of 10/s (the long-run mean), a burst runs at 50/s; at 40/s it runs at 200/s. This is how a limiter that is fine *on average* still gets hurt.

### 2.7 Gamma distribution and the coefficient of variation (CV)
**The idea.** Real service times are always positive and have a long right tail (a few slow ones). The *gamma distribution* fits that. The *coefficient of variation* (CV) is standard deviation ÷ mean, a way to say how spread out times are without depending on units. CV 0 means every request takes exactly the mean; CV 1 behaves like an exponential.

**In Ratescale.** [`backend.ts`](../src/sim/backend.ts) draws service times as gamma with shape `1/cv²` and scale `mean × cv²`, which gives exactly the asked mean and CV. It uses the Marsaglia–Tsang method, which needs a standard normal draw, made with the **Box–Muller transform**.

**Recall:** What does a CV of 0 mean, and why does the code make no random draw for it?

### 2.8 Percentiles (nearest rank)
**The idea.** p99 is the value that 99% of measurements are at or below. It shows the slow tail that an average hides. Never compute it as "mean × constant".

**In Ratescale.** [`metrics.ts`](../src/sim/metrics.ts) keeps recorded latencies over the last 5 seconds and takes percentiles by *nearest rank*: sort, then take the item at position `ceil(p × n)`. With no completed requests the result is `null`, and the page shows a dash.

**Recall:** Why is a dash more honest than showing 0 when nothing finished?

### 2.9 Baseline p99 (the incomplete gamma function)
**The idea.** To say "latency is 3× normal" you need a fixed notion of normal. The baseline p99 is the 99th percentile of service times *alone*, with no waiting.

**In Ratescale.** [`baseline.ts`](../src/sim/baseline.ts) computes it from the Backend's spec with pure arithmetic, no random draws: it solves `P(shape, x / scale) = 0.99` by bisection, using the regularized incomplete gamma function (series and continued fraction, ln-gamma by Lanczos). It exists because a p99 measured early in an overloaded run is already inflated.

### 2.10 Statistical tolerance bands
**The idea.** A test about randomness cannot say "equals 70". It must say "within 3%" on a fixed seed over a run long enough to settle.

**In Ratescale.** Every statistical test fixes a seed and an explicit band (for example, Poisson mean within 3% over 60 simulated seconds). A test that passes on some seeds and fails on others is a bug in the test.

---

## 3. Queueing and capacity

### 3.1 What a queue is
**The idea.** When work arrives faster than it can be served, it waits. The server has *slots* (how many it serves at once). The line has a *limit* (how many may wait). Anything beyond that is turned away.

**In Ratescale.** The Backend has `slots` (4), `queueLimit` (20 to 200) and a mean service time (50 ms). Order is first in, first out ([`fifo.ts`](../src/sim/fifo.ts)).

### 3.2 Capacity (the ceiling)
**The idea.** A server's maximum average throughput is `slots × (1000 / meanMs)` per second.

**In Ratescale.** 4 × (1000 / 50) = **80 per second** in every Scenario. The project rule: do this arithmetic *first* when designing a Scenario.

**Recall:** A Backend has 8 slots and a mean service time of 100 ms. What is its ceiling?
<details><summary>Answer</summary>8 × (1000 / 100) = 80 per second.</details>

### 3.3 Utilization ("busy")
**The idea.** The share of time the slots are doing work. At 70 per second against a ceiling of 80, utilization is 87.5%.

**Why it matters.** Queues do not grow in proportion to load. As utilization nears 100%, waiting time climbs steeply. With random arrivals and varied service times, a queue forms even below 100%.

**In Ratescale.** The Backend measures busy slot time directly; each Snapshot reports `backendUtil`.

### 3.4 Queueing theory as a test oracle
**The idea.** Textbook formulas predict average waits for simple queues. If your simulator matches them, you gain confidence it is correct.

**In Ratescale.** [`tests/queueing.test.ts`](../tests/queueing.test.ts) compares the Backend to the **M/G/1** (one server, general service times) and **M/M/c** (several servers, **Erlang C**) formulas, and checks that at low load the time in the system equals the service time.

### 3.5 Bounded queues and load shedding
**The idea.** An unbounded queue turns overload into delay without limit. A bounded queue *sheds*: it drops new work when full so that what remains is served quickly.

**In Ratescale.** An Attempt that finds the queue full is Shed. The queue limit is itself a lesson: a 200-place queue holds 2.5 s of work at 80/s, five times the 500 ms a client will wait.

### 3.6 Goodput vs throughput
**The idea.** *Throughput* is work done. *Goodput* is work done that **someone was still waiting for**. They can be very different.

**In Ratescale.** Goodput is Requests that Succeeded per second. A Backend can be 100% busy with goodput near 0.

### 3.7 Wasted work and goodput collapse
**The idea.** Real servers usually cannot cancel work already started. If a client times out while its request is queued, the server still does the work when its turn comes, and the answer is thrown away. When the queue is long enough that most requests time out in it, the server spends all its time on answers nobody wants.

**In Ratescale.** A timed-out Attempt keeps its slot until service ends; that time is *Wasted Work* ([`backend.ts`](../src/sim/backend.ts) `abandon`). It is not a bug; it is the mechanism of goodput collapse.

**Recall:** Why can a Backend be 100% busy and finish 0 requests per second?

---

## 4. Rate limiting algorithms

### 4.1 What a rate limiter does
**The idea.** It decides, per request, whether to let it through, so a service is protected from more load than it can take, and so no one caller takes more than its share.

**In Ratescale.** Each Limiter implements `decide(clientId, now)` returning `allow`, `reject` (optionally with a retry time) or `delay` (hold until a release time). It receives `now` as an argument and never reads a clock.

### 4.2 Token bucket
**The idea.** A bucket holds up to `capacity` tokens and refills at `refillPerSec`. Each request takes one token; if there is none, it is rejected. A quiet caller can spend a full bucket at once, so bursts up to `capacity` are allowed, but the long-run rate is the refill rate.

**In Ratescale.** Implemented without a timer: per key it stores the time its bucket will be full again, and derives the token count from that. With capacity 10 and refill 70/s, a token returns every ~14 ms.

### 4.3 Sliding window counter
**The idea.** Count requests in the current window, and add the part of the previous window that still overlaps, *as if its requests were spread evenly*. Allow if the estimate plus this request is within the limit. It is cheap (two counters per key) but it is an estimate.

**In Ratescale.** After a quiet spell the previous window is empty, so a whole window's worth (70) can arrive in a few hundred milliseconds, which is more than the Backend can absorb. That is the lesson of Backend overload.

**Recall:** Both limiters allow 70 per second on average. Why does the sliding window counter hurt the Backend and the token bucket not?

### 4.4 Global vs per-client keys (`keyBy`)
**The idea.** A limit can be shared by everyone or given to each caller. Shared: a greedy caller can use it all. Per caller: a greedy caller only exhausts its own.

**In Ratescale.** `keyBy: 'global' | 'client'`. The Noisy neighbor Scenario uses the same token bucket both ways so the key is the only difference. Note that per-client limits can add up to more than the Backend's ceiling (3 × 40 = 120 against 80); the lesson shows this is fine because a greedy client fills only its own.

### 4.5 Why leaky bucket is a queue
**The idea.** A leaky bucket releases requests at a fixed rate, so it *delays* instead of rejecting. That makes it a queue, not a counter.

**In Ratescale.** The `delay` decision exists for it, and the design is recorded in [`docs/adr/0001-leaky-bucket-as-queue.md`](../docs/adr/0001-leaky-bucket-as-queue.md). Per the project's scope notes, only the sliding window counter and token bucket ship.

### 4.6 Limit too tight vs too loose
**The idea.** A limit below the Backend's ceiling turns work away while the server idles. A limit above it lets in work the server cannot do. The right limit is a little under the ceiling.

**In Ratescale.** The "Limit too tight or too loose" Scenario shows 20/s against 200/s in front of an 80/s Backend. Too loose still finishes *more* work (78–80/s against 20/s at 90/s Demand), but at the cost of 3× the waiting and shed Attempts. So the lesson is not "more is worse".

---

## 5. Reliability: retries, overload and failure

### 5.1 Timeouts
**The idea.** A caller will not wait forever. After `timeoutMs` it gives up on that Attempt.

**In Ratescale.** Each Attempt schedules its own timeout event. A timed-out Attempt is *abandoned*: nothing it does later retries or ends its Request.

### 5.2 Retries and retry amplification
**The idea.** Retrying a failure is sensible, but if every failed caller retries, the load on an already struggling system goes up exactly when it can least take it.

**In Ratescale.** *Retry Amplification* = Offered Load ÷ Demand. At 2.2×, for every new Request the Limiter sees a little more than two Attempts.

### 5.3 Retry modes
**The idea.** *Exponential backoff* waits longer after each failure (base × 2^(n−1)). *Jitter* randomizes the wait so callers that failed together do not return together. *Retry-After* lets the server tell the caller when to come back.

**In Ratescale.** Five modes: none, immediate, backoff, backoff with jitter, wait for Retry-After. Surprise from the Retry storm Scenario: backing off sends *as many or more* Attempts than retrying at once, but later, when the bucket has refilled, so more succeed. Plain backoff beat jitter there (19.7 vs 18.0–18.5 goodput at 40/s).

### 5.4 Retry storm
**The idea.** Retries that arrive too quickly, before whatever caused the failure has changed, add load without adding success.

**In Ratescale.** A retry is "quick" if it starts under 10 ms after the failure (`QUICK_RETRY_MS`). The retry storm rule fires when amplification is high *and* most retries are quick.

### 5.5 Noisy neighbor
**The idea.** In a shared resource, one heavy user degrades everyone else's experience.

**In Ratescale.** One Client asks for 8× as much as each of the others. Under a shared limit, the others are rejected too (a third to a half of their Requests at 3–4× Demand).

### 5.6 Saturation, queue overflow and cascading failure
**The idea.** A saturated server is busy all the time. Its queue fills. A full queue means waiting, which causes timeouts, which cause retries, which add load. One problem feeds the next.

**In Ratescale.** The Diagnoser separates *Causes* (design mistakes) from *Symptoms* (consequences at the Backend) so the card can say what to fix first. Further reading: Google SRE book, ["Addressing Cascading Failures"](https://sre.google/sre-book/addressing-cascading-failures/).

---

## 6. Diagnosis as software design

### 6.1 Rules as pure functions over a window
**The idea.** Each rule looks at the last N Snapshots and returns a detection or nothing. No hidden state about the world; the evidence is the data.

**In Ratescale.** `rule.judge(window, allowed)` over the last 5 Snapshots ([`diagnosis.ts`](../src/sim/diagnosis.ts)). The first judgement waits for the 5-second warm-up plus a full window (10 s total), because early numbers are distorted by the queue filling.

### 6.2 Thresholds as named constants
**The idea.** A number in code with no name is a mystery. Each threshold has a name and a comment saying what it measures and why that value.

**In Ratescale.** For example `SATURATION_BROKEN_BUSY = 0.95`, `RETRY_STORM_AMPLIFICATION = 1.5`, `NOISY_NEIGHBOR_TOP_SHARE = 0.5`. Each rule has two: Warning and Broken.

### 6.3 Hysteresis
**The idea.** If a condition flips on at 0.05 and off at the same 0.05, a value hovering around 0.05 makes the alert flicker. *Hysteresis* uses a different, easier threshold to clear than to trigger.

**In Ratescale.** Rules clear at a margin (for example `QUEUE_OVERFLOW_HYSTERESIS_FRACTION = 0.5`, `SATURATION_BUSY_MARGIN`), so the card does not flash on and off.

**Recall:** Why not use one threshold for both entering and leaving a state?

### 6.4 Ranking: Root Cause vs Contributing
**The idea.** Several problems can fire at once. The student needs the one to fix first.

**In Ratescale.** A Cause outranks a Symptom. With only Symptoms, the order is saturation, then queue overflow, then goodput collapse (`SYMPTOM_ORDER`). Each Finding carries a Fix.

### 6.5 Rules for scenarios written for other rules
A new rule can fire in Scenarios built for a different lesson, so adding one means updating the Findings table test ([`scenario-findings.test.ts`](../tests/scenario-findings.test.ts)).

---

## 7. Software design principles

### 7.1 Functional core, imperative shell
**The idea.** Keep the logic that decides things pure (no clock, no DOM, no network), and put the side effects at the edge.

**In Ratescale.** `src/sim` and `src/runner` are pure; `src/ui` owns the frame loop, the DOM and the address bar. That boundary is enforced by a separate TypeScript config without DOM types ([`tsconfig.sim.json`](../tsconfig.sim.json)) and the scan test.

### 7.2 Deep modules and narrow interfaces
**The idea.** A module that hides much behind a small interface is easier to use and change.

**In Ratescale.** [`src/sim/index.ts`](../src/sim/index.ts) exports only what the runner and UI need. The raw random stream constructor stays private so no code outside the engine can create a stream outside the named set.

### 7.3 Fail loudly at the boundary
**The idea.** Validate inputs where they enter and throw clear errors.

**In Ratescale.** `checkScenario`, `checkBackendSpec`, `checkRetryPolicy` and friends throw `RangeError` with plain messages. A bad Scenario fails where it is defined, not deep in a run.

### 7.4 Domain-driven design vocabulary
**The idea.** Use one precise language in code, tests and UI.

**In Ratescale.** [`CONTEXT.md`](../CONTEXT.md) defines Request, Attempt, Variant, Demand, Goodput, Finding and more, and lists words to *avoid* (for example, "user" for Client, "server" for Backend). A test checks the UI text against the avoided words.

### 7.5 Decision records
**The idea.** Write down why a non-obvious choice was made.

**In Ratescale.** [`docs/adr/`](../docs/adr/) holds architecture decision records. Scenario files carry long doc comments recording measured results (for example, over seeds 1 to 8) so a future change can compare against them.

### 7.6 Data-driven design
A Scenario is plain data (traffic, Backend, Variants). Adding a lesson means adding a data object and tests, not new engine code.

---

## 8. Testing concepts

### 8.1 Invariants
**The idea.** Properties that must hold in *every* run, whatever the configuration. Conservation is the classic one: nothing is created or lost.

**In Ratescale.** [`tests/invariants.test.ts`](../tests/invariants.test.ts) checks them across every Limiter, Retry Policy and traffic shape together, so a bug that only shows in one pairing cannot hide. Example: every Request created ends as succeeded, rejected, timed out, shed, or is still in flight.

### 8.2 Test oracles
**The idea.** Something independent that says what the right answer is: a textbook formula, a hand calculation.

**In Ratescale.** Queueing theory (3.4); and `baselineP99Ms` is checked against the very draws the Backend makes.

### 8.3 Deterministic and statistical tests
Fixed seed, long enough run, explicit tolerance. See 2.10.

### 8.4 Boundary tests
The sim-boundary scan (1.2) tests an *architectural rule* rather than behaviour. It guards the thing most likely to break silently.

### 8.5 Fixtures that fire and fixtures that stay quiet
**The idea.** For each diagnosis rule, one case where it must trigger and one healthy case where it must not.

**In Ratescale.** `tests/diagnosis-*.test.ts`, one file per rule.

### 8.6 Probing before pinning
Scenario numbers are measured with throwaway probe scripts over seeds 1 to 8 (kept under `.scratch/`, not committed), then the test pins a band about twice the worst measured error.

---

## 9. Frontend concepts

### 9.1 The animation frame loop
**The idea.** `requestAnimationFrame` calls your function before each screen repaint, about 60 times a second. Browsers pause it for hidden tabs.

**In Ratescale.** The loop converts the frame timestamp into wall milliseconds (0 for the first frame and while hidden), ticks the runner, and publishes. After the tab returns, the first frame counts 0, so time spent hidden never counts.

### 9.2 Decoupling simulation rate from render rate
**The idea.** Computing the world and drawing it are separate jobs at separate rates.

**In Ratescale.** The runner may tick every frame, but the React state is updated about 30 times a second (`PUBLISH_MS`), saving renders.

### 9.3 React state, effects, memoization
**The idea.** State change re-renders a component; `memo`, `useMemo` and `useCallback` skip work when inputs are unchanged; an effect with a cleanup attaches and detaches things like event listeners.

**In Ratescale.** The runner lives in a lazy `useState` for the component's lifetime. Controls are created once so passing them down never re-renders children. Panels are wrapped in `memo`. A `key` on the Scenario component gives a fresh runner per Scenario.

### 9.4 Derived values and pure view helpers
Formatting, stats and chart geometry sit in plain `.ts` files (`stats.ts`, `geometry.ts`, `tabs.ts`) so they can be unit tested without rendering.

### 9.5 Hand-drawn SVG charts
Charts are written in SVG rather than a library: full control, no dependency, exact alignment with the data. The window chart plots a rolling count sampled every tenth of a window (see [`window-counts.ts`](../src/sim/window-counts.ts)) because per-second buckets can split a burst across a window edge and make each half look small.

### 9.6 URL as state
The address bar holds `s`, `seed`, `d`, `r`. Parsing never throws: each bad field falls back to the Scenario's own.

### 9.7 Responsive layout and accessibility
**The idea.** The design adapts to phone width (tabs plus a Compare tab). Text must meet WCAG AA contrast; native elements like `<details>` give keyboard access; `prefers-reduced-motion` turns transitions off.

### 9.8 CSS tokens and specificity
Colours come from tokens in `tokens.css`. A known trap: class and attribute selectors have equal specificity, so source order decides. The project declares `--k-*` tokens only on the kind-attribute rule and puts fallbacks inside `var()`.

---

## 10. Tooling and deployment

| Tool | What it is for |
|---|---|
| **TypeScript** | Types catch mistakes early; separate configs (`tsconfig.app.json`, `tsconfig.sim.json`) let the sim be checked without DOM types. |
| **Vite** | Dev server with hot module replacement (HMR) and the production build. Stale HMR modules can survive a change, so hard-reload before concluding something is broken. |
| **Bun** | Package manager and runtime. `bun run test` runs Vitest; plain `bun test` starts Bun's own runner. |
| **Vitest** | Test runner, Jest-like, built on Vite. |
| **oxlint, Prettier** | Linting and formatting; CI runs both. |
| **GitHub Actions** | CI on every push: lint, format check, tests and build. |
| **Vercel** | Hosting. `vercel.json` runs `bun run test && bun run build`, so a failing test blocks a deploy. |

---

## 11. Concept map

```
                      ┌────────────── determinism ──────────────┐
                      │                                         │
          simulated clock + event queue            seeded streams (traffic · service · jitter)
                      │                                         │
                      └──────────► discrete-event engine ◄──────┘
                                         │
        Poisson / bursty arrivals ───────┤
        gamma service times ─────────────┤
                                         ▼
        Limiter (token bucket · sliding counter)  ──reject──►  Retry Policy ──► more Attempts
                  │ allow                                          ▲
                  ▼                                                │ shed / timeout
        Backend (slots + bounded queue) ───────────────────────────┘
                  │
                  ▼  counted events
        Snapshots (1 per sim second) → percentiles, goodput, busy, wasted work
                  │
                  ▼
        Diagnoser (rules · thresholds · hysteresis · ranking) → Findings → card in the UI
```

**A final self-test.** Without looking: explain, in four sentences, what happens from the moment the student drags Demand to 120 in the Goodput collapse Scenario until the card turns red. Use these words: *queue, timeout, wasted work, goodput, Root Cause*. Then compare with the Goodput collapse row of [`features.md`](features.md).

**Primary source to read next:** the Google SRE book chapter ["Handling Overload"](https://sre.google/sre-book/handling-overload/). It covers, in real systems, the ideas in sections 3 and 5.
