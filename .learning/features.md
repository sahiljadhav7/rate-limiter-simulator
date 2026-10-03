# What each feature of Ratescale does

A guided tour of the project, one feature at a time: what it does, how it does it, and why it is there. Read it with the architecture diagram open beside you: [`.archify/architecture-ratescale-20261003-125851/ratescale.html`](../.archify/architecture-ratescale-20261003-125851/ratescale.html).

Words in **bold capitals** (Request, Attempt, Variant, Demand, Goodput, Finding) are the project's own terms, defined in [`CONTEXT.md`](../CONTEXT.md). This file uses them the same way.

> Stuck on anything? Ask your agent. It is your teacher here and can open any file mentioned below with you.

---

## The big picture in one paragraph

A student picks a **Scenario** (one lesson). The Scenario runs the *same* seeded traffic through two **Variants** side by side. Each Variant is a rate limiter plus a retry rule, in front of an identical simulated **Backend**. The student raises the **Demand** until something breaks. Then a **diagnosis card** names what broke, shows the measured numbers, says why it happened and suggests a fix. Everything on screen is counted from simulated events; nothing is drawn to look right ([`CLAUDE.md`](../CLAUDE.md), "The one rule").

The flow, top to bottom:

```
Student → App + top bar → useRunner frame loop → Runner
                                                   ├─ Shared traffic source  (same arrivals for every Variant)
                                                   └─ Engine per Variant → Limiter → Backend
                                                                              └─ Retry Policy
                                                   └─ Diagnoser per Variant  (Findings)
        Variant panels  ← setView about 30 times a second
```

---

## Part 1: The simulation engine (`src/sim`)

This is the heart of the project. It is pure TypeScript: no React, no DOM, no real timers ([`src/sim/index.ts`](../src/sim/index.ts) lines 1-12). That boundary is what makes it testable and lets it run without the page (see the README's code example).

### 1.1 Simulated clock and event queue
**What it does:** Time in the simulation is a number the engine moves forward itself, never the computer's clock. Things that will happen later (a service ending, a timeout firing, a retry starting) go into an event queue ordered by time. Equal times pop in the order they were added.

**Why it matters:** Because nothing depends on how fast your computer is, the same run gives the same numbers every time. That is the basis of every other feature.

Files: [`clock.ts`](../src/sim/clock.ts), [`event-queue.ts`](../src/sim/event-queue.ts).

### 1.2 Seeded random streams
**What it does:** One seed number produces three separate random streams: `traffic` (when Requests arrive), `service` (how long the Backend takes), and `jitter` (random retry waits) ([`rng.ts`](../src/sim/rng.ts) lines 44-103).

**Why three and not one:** If retries drew from the same stream as arrivals, turning on retries would shift every later arrival, and the two Variants would no longer see the same traffic. Separate streams mean an extra draw in one never moves the others.

### 1.3 Shared traffic source
**What it does:** Generates new Requests as simulated time advances and writes them to one log. Every Variant reads that log through its own reader, so both panels get *identical* arrivals ([`traffic-source.ts`](../src/sim/traffic-source.ts) lines 1-12).

**Detail worth knowing:** It generates arrivals exactly up to the time asked for, never ahead. If it generated per animation frame instead, a slow computer would change the run.

Traffic shapes include steady Poisson traffic and bursty on/off traffic (Backend overload is on for 1 second, off for 4).

### 1.4 The Limiter (two algorithms)
**What it does:** For each **Attempt** the Limiter answers **Allow** or **Reject** ([`limiter.ts`](../src/sim/limiter.ts)). It is given the current time and never reads a clock itself.

| Algorithm | How it counts | What it teaches |
|---|---|---|
| **Sliding window counter** | Counts Attempts in the last window (for example 70 per 1 second), blending the previous window in. | After a quiet spell it remembers an empty window, so it lets a whole window's worth through *at once*. |
| **Token bucket** | A bucket of `capacity` tokens refills at `refillPerSec`. Each Attempt takes one token. | It paces traffic: at most `capacity` at once, then one every `1000 / refillPerSec` ms. |

Both can count **globally** (one count for all Clients) or **per Client** (one count each). That choice is the whole lesson of the Noisy neighbor Scenario.

Further reading: Cloudflare explains the sliding window counter in ["How we built rate limiting capable of scaling to millions of domains"](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/); the token bucket is described on [Wikipedia](https://en.wikipedia.org/wiki/Token_bucket).

### 1.5 The Backend
**What it does:** The simulated service behind the Limiter. It has a fixed number of **slots** (Attempts served at once) and a **bounded queue** where Attempts wait for a slot ([`backend.ts`](../src/sim/backend.ts) lines 1-27). An Attempt that finds the queue full is **Shed** (dropped).

**Key number:** its ceiling is `slots × (1000 / meanMs)` Requests per second. Every shipped Scenario uses 4 slots × (1000 / 50 ms) = **80 per second**.

**The surprising rule:** the Backend never cancels work. If a caller times out, its Attempt still holds its slot until service ends. That time is called **Wasted Work**. It is deliberate, because real servers behave this way, and it is what makes "goodput collapse" possible.

### 1.6 Retry Policy
**What it does:** Decides whether and when a failed Attempt (Rejected, Shed or Timed out) gets another try ([`retry-policy.ts`](../src/sim/retry-policy.ts)). The five modes in the panel's dropdown:

| Mode | Behaviour |
|---|---|
| No retry | The Request fails at once. |
| Retry at once | Tries again immediately, with no wait. |
| Back off | Waits base × 2^(n − 1): 100 ms, then 200 ms, and so on. |
| Back off with jitter | Waits a random time between 0 and that backoff, so callers who failed together don't all come back together. |
| Wait for Retry-After | Waits as long as the Limiter's Reject says; if it says nothing, backs off with jitter. |

Further reading: AWS Builders' Library, ["Timeouts, retries, and backoff with jitter"](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/).

### 1.7 The engine (one per Variant)
**What it does:** Ties the above together for one Variant ([`engine.ts`](../src/sim/engine.ts)). It reads new Requests from the shared log, starts each Attempt with a timeout, asks the Limiter, submits allowed Attempts to the Backend, and hands failures to the Retry Policy. It counts every one of these events.

The life of one Attempt:
1. It reaches the Limiter and its timeout clock starts.
2. **Reject:** the Retry Policy decides whether to schedule another Attempt or end the Request.
3. **Allow:** the Backend starts it, queues it, or sheds it.
4. If the timeout fires first, the caller gives up. The Attempt keeps running as Wasted Work, and its late answer is thrown away.
5. If the Backend answers in time, the Request **Succeeded**.

### 1.8 Metrics and Snapshots
**What it does:** Every simulated second the engine takes a **Snapshot**: Demand, Offered Load, how many were allowed, rejected and shed, Goodput, Backend busy time, queue depth, and latency percentiles ([`metrics.ts`](../src/sim/metrics.ts)).

**Honesty rules:**
- Percentiles (p50, p95, p99) are taken from recorded latencies over the last 5 seconds, never estimated from an average.
- A value with nothing to measure is `null` and the page shows a dash, never a made-up number.
- The first 5 seconds are a warm-up and are not diagnosed.

### 1.9 The Diagnoser (seven rules)
**What it does:** Looks at the last 5 Snapshots and decides what is going wrong ([`diagnosis.ts`](../src/sim/diagnosis.ts)). Each rule has two named thresholds: **Warning** (amber, trouble starting) and **Broken** (red).

| Failure Mode | Kind | It fires when… |
|---|---|---|
| Limit too loose | Cause | The limit lets in more than the Backend can serve. |
| Limit too tight | Cause | The Limiter rejects lots while the Backend sits mostly idle. |
| Retry storm | Cause | Retries multiply traffic (Offered Load ÷ Demand climbs) and most come back too quickly. |
| Noisy neighbor | Cause | One Client takes most of a shared limit, and the others get rejected. |
| Backend saturation | Symptom | The Backend is nearly always busy and latency has grown well past normal. |
| Queue overflow | Symptom | A share of Attempts is shed because the queue is full. |
| Goodput collapse | Symptom | Goodput falls far below the Variant's own best, while the Backend stays busy. |

A **Cause** is a design mistake; a **Symptom** is what you see at the Backend. When both fire, a Cause is named the **Root Cause** and the rest are **Contributing**. With only Symptoms, the order is saturation, then queue overflow, then goodput collapse. Each Finding comes with a **Fix**, a step the student can take.

---

## Part 2: The runner (`src/runner`)

### 2.1 Scenario
**What it is:** One lesson as data ([`scenario.ts`](../src/runner/scenario.ts) lines 34-65): a title, what to watch, why it happens, what it models and leaves out, a seed, the traffic, the Backend, and one to three Variants. `checkScenario` builds every part once, so a broken Scenario fails where it is defined.

### 2.2 Runner: lockstep and event budget
**What it does:** Builds one shared traffic source and one engine plus one Diagnoser per Variant ([`runner.ts`](../src/runner/runner.ts) lines 177-195). Every frame it:
1. Takes the frame's wall time (capped at 100 ms) times the speed (0.5×, 1×, 10×).
2. Moves forward in 50 ms steps: first the traffic, then every engine to the *same* simulated time.
3. Gives each new Snapshot to that Variant's Diagnoser.
4. Stops early once 12,000 events have been handled in the frame, so the tab never freezes. The footer then says the run is going slower than asked.

**Why lockstep:** both panels always show the same moment, so the comparison is fair.

It also handles pause, step one second, reset, restart with an edited Scenario, speed changes and live load changes. Every load change is recorded in a **timeline**. Seed plus timeline replays the run exactly.

---

## Part 3: The page (`src/ui`, React)

### 3.1 Frame loop (`useRunner`)
Calls the runner once per animation frame and copies its view into React state about 30 times a second ([`use-runner.ts`](../src/ui/use-runner.ts)). Browsers stop animation frames in a background tab, so the hidden time is never counted, and a notice tells the student the run stood still.

### 3.2 Scenario picker: the five lessons
All share a Backend with a ceiling of 80 per second.

| Scenario | Compares | Lesson |
|---|---|---|
| **Backend overload** (default) | Sliding window counter vs token bucket, both 70/s | Same average limit; the sliding counter lets a burst through at once and the Backend sheds work, while the token bucket paces it. Raise Demand to 20-40. |
| **Noisy neighbor** | Token bucket shared by all Clients vs one per Client | One Client asks for 8× the others. Shared, it crowds them out; per Client, only it is slowed. |
| **Retry storm** | Retry at once vs Back off | At high Demand, retrying at once comes back into an empty bucket and multiplies load. Backing off retries later, when there is room. |
| **Goodput collapse** | Token bucket of 120/s vs 60/s, long queue, 500 ms timeout | Raise Demand to 120: the looser limit fills the queue, everyone times out, and the Backend works 100% on Wasted Work while finishing almost nothing. |
| **Limit too tight or too loose** | Token bucket of 20/s vs 200/s | 20 rejects work while the Backend idles; 200 lets the Backend saturate. The fix is a limit a little under the ceiling. |

### 3.3 Top bar controls
- **Demand slider:** new Requests per second, applied live.
- **Burst:** 5× Demand for 2 seconds.
- **Play, pause, step:** step moves exactly one simulated second while paused.
- **Speed:** 0.5×, 1×, 10×.
- **Seed:** a different seed gives different but equally reproducible traffic. Changing it restarts the run.
- **Reset:** back to time 0 of the same setup.

### 3.4 Variant panel
One per Variant: the Limiter's name and scope, a **pipeline strip** (Clients → Limiter → Backend) whose nodes turn amber or red with trouble, a **stat row**, and **charts** over time. A **Retry Policy dropdown** restarts the run with the new policy. The window chart plots allowed Attempts in the last window, sampled every tenth of a window, because per-second buckets would hide a burst that straddles a window edge.

### 3.5 Diagnosis card
Shows the Root Cause first, then Contributing Findings, each with its severity, the measured numbers, a plain-words "why", and the Fix steps. Charts mark where past Findings started.

### 3.6 Scenario notes and "What the numbers mean"
Handwritten-style notes say what to watch, what the model includes, and what it leaves out. A disclosure below defines the 15 numbers a student reads, from Demand to Baseline p99 ([`glossary.ts`](../src/ui/notes/glossary.ts)).

### 3.7 Share link
The address bar always holds `?s=<scenario>&seed=<n>&d=<demand>&r=<retry modes>` ([`url-state.ts`](../src/ui/share/url-state.ts)). **Share** copies it, and opening the link reopens the exact setup. Bad values fall back to the Scenario's own, so a broken link never crashes the page.

### 3.8 Phone layout and ledger
On a phone, the panels become tabs plus a **Compare** tab, with badges showing each Variant's worst severity. The footer **ledger** shows Variants, seed, simulated time, speed and events handled.

---

## Part 4: Tests and deployment

- **Tests** (`bun run test`, Vitest): invariants (nothing is created or lost), each limiter's own "never exceeds" rule, queueing results against theory, exact replay from a seed, each Scenario's lesson, and a diagnosis table listing which Findings each Scenario produces.
- **Deploy:** Vercel runs `bun run test && bun run build`, so a failing test blocks a deploy ([`vercel.json`](../vercel.json)).

---

## Check yourself (retrieval practice)

Answer from memory first, then open the answer. Come back in a few days and try again; recalling it after a gap is what makes it stick.

1. Why does Ratescale use three random streams instead of one?
   <details><summary>Answer</summary>So an extra draw in one stream (for example, a retry's jitter) never shifts the others. The two Variants keep seeing identical traffic, and replays stay exact.</details>

2. Both Limiters in Backend overload allow 70 per second, under the Backend's 80. Why does only the sliding window counter break it?
   <details><summary>Answer</summary>After 4 quiet seconds it sees an empty window and lets 70 through as fast as the burst brings them. The 20-place queue overflows. The token bucket holds only 10 tokens, then releases one every ~14 ms.</details>

3. What is Wasted Work, and which Scenario depends on it?
   <details><summary>Answer</summary>Backend time spent on Attempts whose caller already timed out. Goodput collapse depends on it: the Backend stays 100% busy but finishes almost nothing on time.</details>

4. What is the difference between a Cause and a Symptom?
   <details><summary>Answer</summary>A Cause is a design mistake (limit too loose or too tight, retry storm, noisy neighbor). A Symptom is what you see at the Backend (saturation, queue overflow, goodput collapse). A Cause wins Root Cause.</details>

5. Why does the runner move every engine to the same simulated time in 50 ms steps?
   <details><summary>Answer</summary>So both panels always show the same moment (a fair comparison), and so it can check the 12,000-event budget between steps and never freeze the tab.</details>

6. Work it out: what is the Backend's ceiling with 4 slots and a mean service time of 50 ms?
   <details><summary>Answer</summary>4 × (1000 / 50) = 80 Requests per second.</details>

---

**Primary source to read next:** the Google SRE book chapter ["Handling Overload"](https://sre.google/sre-book/handling-overload/). It covers, for real systems, the same failure modes Ratescale simulates. More sources are in [`RESOURCES.md`](RESOURCES.md).
