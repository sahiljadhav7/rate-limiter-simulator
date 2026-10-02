# Ratescale

[![CI](https://github.com/sahiljadhav7/rate-limiter-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/sahiljadhav7/rate-limiter-simulator/actions/workflows/ci.yml) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)

A rate-limiting simulator for students. The same seeded traffic runs through two rate limiters side by side; raise the load until something breaks, and the page shows what broke and why.

**Live:** [rate-limiter-simulator-zeta.vercel.app](https://rate-limiter-simulator-zeta.vercel.app/)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/backend-overload-dark.gif">
  <img alt="Backend overload: Demand is dragged from 10 to 40 Requests per second, and the sliding window counter's Backend turns red while the token bucket's stays blue" src="docs/backend-overload.gif">
</picture>

## Motivation

Diagrams show a rate limiter's rule, not what it does under load. "Allows 70 a second" sounds safe until one limiter lets all 70 in at once and the service behind it starts dropping work. Ratescale makes that visible, with every number counted from a real simulation.

## Features

- One Scenario, **Backend overload**: sliding window counter against token bucket, the two algorithms the simulator models
- Live Demand slider, bursts, pause, step, speed, and a Retry Policy per panel
- Deterministic: the same seed replays the same run
- **Share** copies a link that reopens the exact setup
- Handwritten notes say what to watch and what the model leaves out

## Tech used

React 19, TypeScript, Vite, Vitest and Bun. Charts are hand-drawn SVG; the simulation in `src/sim` has no dependencies.

## Installation

Needs [Bun](https://bun.sh) 1.3.9 or later.

```sh
git clone https://github.com/sahiljadhav7/rate-limiter-simulator.git
cd rate-limiter-simulator
bun install
bun run dev    # http://localhost:5173
```

## How to use

1. Open the app on **Backend overload** and drag **Demand** to 30: the sliding window counter's Backend turns red, the token bucket's doesn't.
2. Set a panel's **Retry Policy** to "Retry at once" and watch retries pile on.
3. Read the diagnosis card: it names what failed, shows the numbers, says why, and lists the steps to fix it.
4. Press **Share** to copy a link to that setup.

## Code example

The engine runs without the page:

```ts
import { createRunner } from './src/runner/runner.ts'
import { backendOverloadScenario } from './src/ui/scenarios/backend-overload.ts'

const scenario = { ...backendOverloadScenario, traffic: { ...backendOverloadScenario.traffic, demandRps: 30 } }
const runner = createRunner(scenario, { eventBudget: Infinity })
while (runner.view().simMs < 60_000) runner.tick(100) // one simulated minute
for (const v of runner.view().variants) console.log(v.label, v.totals.requests.succeeded)
// Sliding window counter 700
// Token bucket 943
```

## Tests

```sh
bun run test
```

Invariants, each limiter, queueing against theory, exact replay, and each Scenario's lesson. CI runs lint, format check, tests and build on every push.

## Contribute

Read [`CLAUDE.md`](CLAUDE.md) first: every number must come from the simulation, runs stay deterministic, and `src/sim` never touches the page. Run `bun run lint`, `bun run test` and `bun run build` before a pull request.

## Credits

Inspired by [Breakscale](https://github.com/xevrion/breakscale), whose visual style it follows. Notes use [Caveat](https://github.com/googlefonts/caveat) (SIL Open Font License).

## License

MIT © sahiljadhav7
