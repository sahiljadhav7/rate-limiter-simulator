# Ratescale Design

Ratescale borrows its visual language from [Breakscale](https://breakscale.tech/), so the two read as siblings: warm graph paper, floating rounded islands, monospace numbers under small uppercase labels, one soft colour family per kind of component, and handwritten notes on the paper. The layout does not copy Breakscale. Breakscale is a free canvas; Ratescale is a fixed row of **Variant** panels on one **Scenario** (terms as in `CONTEXT.md`).

Token values below were read from Breakscale's published stylesheet (September 2026) and trimmed to what Ratescale uses. Keep the name, logo and copy our own; only the style is shared, and the README credits Breakscale for it.

## Principles

1. **The numbers are the interface.** Every live value is monospace with tabular figures, so digits do not jitter as they change. Labels are small, uppercase and letter-spaced; values are large.
2. **Paper, not chrome.** The page is a sheet of graph paper. Controls float on it as islands with a 1px border and a soft shadow. No heavy toolbars, gradients or glass.
3. **Colour means something.** Neutrals carry the layout. Colour appears only for a component's kind (client, limiter, backend) or for state (ok, warn, danger). Never decorative.
4. **Explain on the paper.** Scenario explanations are handwritten notes placed next to what they describe, as a teacher would scribble in a margin.
5. **Calm motion.** Transitions are 120 to 200 ms and only fade or slide a few pixels. The simulation is what moves; the interface does not.

## Design constraints

- No emoji, glassmorphism, gradient text, or glowing shadows
- Colour carries meaning: component colours identify a kind, status colours mean trouble
- Numbers in the mono stack with tabular figures
- Interactive transitions only, 120-200ms, and `prefers-reduced-motion` disables them
- All colour from tokens in `src/ui/tokens.css`. No hardcoded hex elsewhere.
- WCAG AA on text. Compute the ratio, do not eyeball it.


## Tokens

Put these in `src/ui/tokens.css`. Light is the default; dark applies under the system preference unless the user picked light, and under an explicit `data-theme="dark"`.

```css
:root {
  color-scheme: light;

  /* Type */
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --hand: "Caveat", "Segoe Print", "Bradley Hand", Chalkboard, cursive;
  --fs-label: 11px;  --tr-label: .06em;  --lh-label: 1.25;
  --fs-sm: 12px;     --tr-sm: 0;         --lh-sm: 1.5;
  --fs-base: 14px;   --tr-base: -.005em; --lh-base: 1.6;
  --fs-num: 16px;    --tr-num: -.01em;   --lh-num: 1.15;
  --fs-lg: 22px;     --tr-lg: -.018em;
  --fs-hero: 34px;   --tr-hero: -.025em; --lh-hero: 1;
  --fw-body: 450; --fw-med: 550; --fw-num: 650;

  /* Space, radius, borders */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-7: 28px; --sp-10: 40px;
  --r-mark: 2px; --r-sm: 6px; --r-btn: 8px; --r-md: 10px; --r-lg: 14px; --r-pill: 999px;
  --bw: 1px; --bw-strong: 1.5px;
  --track-h: 6px; --thumb: 18px;

  /* Motion */
  --dur-fast: .12s; --dur-base: .16s; --dur-slow: .2s;
  --ease: cubic-bezier(.4, 0, .2, 1);
  --ease-out: cubic-bezier(.16, .84, .44, 1);

  /* Surfaces and lines */
  --bg: #faf7f3;  --surface: #fffdfa;  --surface-2: #f7f3ee;  --surface-3: #f0ece5;
  --border: #e8e2da;  --border-strong: #8e8a83;
  --grid-line: #f1ece6;  --grid-major: #e7e2dc;
  --line: #cfc8bf; --line-2: #b3aba1; --line-3: #948c82; --line-4: #6f6a63; --line-5: #545049;
  --track: #ece7e0;

  /* Text */
  --text: #1e242e;  --text-dim: #525862;  --text-faint: #646972;  --text-on-fill: #fff;

  /* Accent (interactive) */
  --accent: #325cbd; --accent-hover: #2a4fa5; --accent-press: #23438c; --accent-fg: #fff;
  --accent-soft: #e3edff; --accent-ink: #2d5277; --accent-ring: #325cbd52;

  /* State */
  --ok: #187a3b;  --warn: #945500;  --danger: #c52b30;           /* text */
  --ok-mark: #319751; --warn-mark: #c57800; --danger-mark: #d73337; /* lines, fills, markers */
  --ok-soft: #e6f4ea; --warn-soft: #fbeedb; --danger-soft: #fdeceb; /* backgrounds */

  /* Depth */
  --shadow-sm: 0 1px 2px #3c322829;
  --shadow-md: 0 1px 2px #3c32280d, 0 4px 10px #3c322812;
  --shadow-lg: 0 2px 4px #3c32280d, 0 12px 28px #3c32281a;
  --bevel: #ffffffe6;  --bevel-on-accent: #ffffff29;
  --scrim: #3c322829;

  /* Kinds: fill (background), line (edges, meters), stroke (outline), ink (text on fill) */
  --kind-client-fill: #f2effe;  --kind-client-line: #b09de9;  --kind-client-stroke: #866fc2;  --kind-client-ink: #534775;
  --kind-limiter-fill: #e9f5e9; --kind-limiter-line: #7dbd7f; --kind-limiter-stroke: #4b934f; --kind-limiter-ink: #345b35;
  --kind-backend-fill: #eaf2ff; --kind-backend-line: #85abf0; --kind-backend-stroke: #567fca; --kind-backend-ink: #394f79;
  --kind-queue-fill: #f5eefc;   --kind-queue-line: #c097df;   --kind-queue-stroke: #9769b8;   --kind-queue-ink: #5c446f;
  --kind-retry-fill: #f8edfa;   --kind-retry-line: #cc93d4;   --kind-retry-stroke: #a365ac;   --kind-retry-ink: #634168;
  --kind-store-fill: #e4f4fd;   --kind-store-line: #57b8e3;   --kind-store-stroke: #008cb9;   --kind-store-ink: #185771;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* same block as [data-theme="dark"] below */ }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #16151a;  --surface: #1d1c22;  --surface-2: #25242b;  --surface-3: #2f2e36;
  --border: #302f38;  --border-strong: #6a6878;
  --grid-line: #1e1d23;  --grid-major: #26252c;
  --line: #4a4855; --line-2: #615f6e; --line-3: #807d8c; --line-4: #a29fae; --line-5: #c4c1cf;
  --track: #2b2a32;
  --text: #eceaf2;  --text-dim: #a8a5b4;  --text-faint: #8d8a99;  --text-on-fill: #16151a;
  --accent: #6f9bf0; --accent-hover: #87acf5; --accent-press: #5b86dc; --accent-fg: #16151a;
  --accent-soft: #1b2740; --accent-ink: #a9c6ff; --accent-ring: #6f9bf061;
  --ok: #4ac06e;  --warn: #d79a2b;  --danger: #f0656a;
  --ok-mark: #3fae61; --warn-mark: #c98a1c; --danger-mark: #e2565c;
  --ok-soft: #16301f; --warn-soft: #332616; --danger-soft: #3a1d1f;
  --shadow-sm: 0 1px 2px #0006;
  --shadow-md: 0 1px 2px #0000005c, 0 4px 10px #00000070;
  --shadow-lg: 0 2px 4px #0000005c, 0 12px 28px #00000085;
  --bevel: #ffffff12;  --bevel-on-accent: #ffffff24;  --scrim: #0000008f;
  --kind-client-fill: #261e3a;  --kind-client-line: #7154b2;  --kind-client-stroke: #ac8ff9;  --kind-client-ink: #d4c7ff;
  --kind-limiter-fill: #122a14; --kind-limiter-line: #217d2d; --kind-limiter-stroke: #60bd66; --kind-limiter-ink: #b0e0b0;
  --kind-backend-fill: #15243c; --kind-backend-line: #3865ba; --kind-backend-stroke: #6ea3ff; --kind-backend-ink: #b5d2ff;
  --kind-queue-fill: #2b1d37;   --kind-queue-line: #824da6;   --kind-queue-stroke: #c287ec;   --kind-queue-ink: #e1c3fa;
  --kind-retry-fill: #2f1b33;   --kind-retry-line: #8f4799;   --kind-retry-stroke: #d182dc;   --kind-retry-ink: #ebc0f1;
  --kind-store-fill: #022839;   --kind-store-line: #0075ab;   --kind-store-stroke: #00b4ee;   --kind-store-ink: #99dcfc;
}
```

The two blocks above are the source of truth for each theme's values. In `src/ui/tokens.css` each colour is written once as `light-dark(<light>, <dark>)` (shadows per layer colour), so the themes cannot drift; `tests/tokens.test.ts` checks both against these blocks. `:root` sets `color-scheme: light dark`, which follows the system, and `[data-theme="light"]` or `[data-theme="dark"]` sets `color-scheme` to force one. `light-dark()` needs Chrome 123, Firefox 120 or Safari 17.5.

**Kind mapping.** Client is violet, Limiter is green, Backend is blue, the leaky bucket's queue is purple, retries are pink-violet, and the distributed scenario's shared counter store is cyan. A kind's colour is the same wherever it appears: its pipeline node, its meter fill and its chart series.

## Base styles

- `body`: `--sans`, `--fs-base`, weight `--fw-body`, `--lh-base`, `--tr-base`, colour `--text` on `--bg`. Antialiased, `font-synthesis: none`.
- **Graph paper** covers the whole viewport behind everything: a 16px grid in `--grid-line` with every fifth line in `--grid-major`, drawn with two `linear-gradient` backgrounds. It never scrolls separately from the page.
- **Numbers**: any live value uses `--mono` with `font-variant-numeric: tabular-nums`. Units sit beside the value in `--fs-sm` and `--text-dim` (for example `151ms`, `45/s`).
- **Label**: `--fs-label`, weight `--fw-med`, uppercase, `--tr-label`, colour `--text-faint`. Every metric has one above or beside it.

## Components

**Island.** The container for every floating group. `--surface`, `1px solid --border`, radius `--r-lg`, `--shadow-md`, padding `--sp-3`. Islands never touch each other; keep a `--sp-3` gap.

**Button.** Height 36px, padding `0 --sp-3`, radius `--r-btn`, `1px solid --border-strong`, `--surface`, weight `--fw-med`, `box-shadow: --shadow-sm, inset 0 1px 0 --bevel`. Hover darkens the border; press moves down 1px. Variants:
- *Primary*: `--accent` fill, `--accent-fg` text, weight `--fw-num`, bevel `--bevel-on-accent`. At most one per view (Apply fix).
- *Ghost*: no border or shadow until hover.
- *Icon*: 32 to 36px square. Grouped buttons (play, step, reset) share borders and round only the outer corners.

**Slider (Demand).** Track height `--track-h` in `--track`, filled part in `--accent`, round thumb `--thumb` with a white fill and `--accent` border. **Log scale** from 1 to 1,000 requests per second, with mono tick labels at 1, 10, 100 and 1k beneath the track. The current value appears to its left in `--fs-lg` mono, labelled DEMAND and followed by the unit `requests / sec`.

**Pill.** Height 22px, radius `--r-pill`, `--surface-2`, label type. Use it for tags such as a limiter's algorithm (`TOKEN BUCKET`), `PER CLIENT` or `WARM-UP`.

**Pipeline node.** A small card per stage in a Variant: Clients → Limiter → Backend. Kind `-fill` background, `--bw-strong` border in kind `-stroke`, radius `--r-md`. Top row: icon and name in `--fs-base`. Below a hairline, two or three metrics as value + label, for example `7.3% BUSY`, `151ms P99`, `0 WAITING`. The value is mono and the label is uppercase, bold, in kind `-ink`. A meter runs along the bottom edge: a `--track` track with a kind `-stroke` fill that turns `--danger-mark` when the node is failing.

**Edge.** The arrow between nodes is a dashed line in `--line-2` whose dashes animate in the direction of flow. Their speed scales with the rate, and they stop when the rate is zero. The rate (`85/s`) sits above the line in mono. A failing edge turns `--danger` at half opacity.

**Stat.** Label above, value below in `--fs-num` mono at weight `--fw-num`. The panel's headline stat, Attempt p99, uses `--fs-hero`. A value turns `--warn` or `--danger` only when a Finding is active for it.

**Chart.** Hand-drawn SVG (see the Charts section).

**Handwritten note.** Scenario explanations in `--hand` at about 20px, colour `--text`, sitting directly on the graph paper with no island around them, placed beside what they explain. Keep each note to two to four short lines. Load Caveat (weights 400 to 700) self-hosted, with `font-display: swap`.

**Ledger.** A single-line status strip at the bottom-left: mono, `--fs-label`, uppercase, `--text-faint`, on `--surface` with a `--border` outline and radius `--r-btn`. Content: `3 VARIANTS · SEED 42 · T 64.2s · 1× · 18,204 EVENTS`. When the event budget is hit it adds `RUNNING SLOWER THAN REQUESTED` in `--warn`.

**Diagnosis card.** An island that slides up 6px and fades in (`--dur-slow`, `--ease-out`) inside the affected Variant's panel. A 3px left border in `--danger-mark` (`broken`) or `--warn-mark` (`warn`), background `--danger-soft` or `--warn-soft`. Contents, in order:
1. A pill (ROOT CAUSE or CONTRIBUTING) and the Failure Mode label in `--fs-lg`.
2. An evidence table of mono values with labels.
3. **Why**, in body text.
4. **How to fix**, as a ranked list. Each Fix with a patch gets an **Apply fix** primary button.

## Layout

### Desktop (1024px and wider)

```
┌ paper grid ──────────────────────────────────────────────────────────────────┐
│ ┌──────────────┐ ┌───────────────────────────────────────────┐ ┌──────────┐ │
│ │ Ratescale  ▾ │ │ DEMAND 50 req/s ━━━━●━━━━  ▶ ⏭ ↺   1× ▾  │ │ Share  ≡ │ │
│ │ Boundary burst│ │           1   10   100   1k               │ └──────────┘ │
│ └──────────────┘ └───────────────────────────────────────────┘              │
│                                                                              │
│ ┌ Variant A: Fixed window ──────────┐ ┌ Variant B: Sliding counter ───────┐ │
│ │ [FIXED WINDOW] [GLOBAL]            │ │ [SLIDING COUNTER] [GLOBAL]         │ │
│ │ (Clients)→(Limiter)→(Backend)      │ │ (Clients)→(Limiter)→(Backend)      │ │
│ │ OFFERED  GOODPUT  REJECTED  P99    │ │ OFFERED  GOODPUT  REJECTED  P99    │ │
│ │ 120/s    48/s     58%      151ms   │ │ ...                                │ │
│ │ ┌ allowed in last window ───────┐ │ │ ┌───────────────────────────────┐ │ │
│ │ │    ╱╲   limit ┄┄┄┄┄┄┄┄  2.0×  │ │ │ │                               │ │ │
│ │ └───────────────────────────────┘ │ │ └───────────────────────────────┘ │ │
│ │ ┌ latency p50/p95/p99 ──────────┐ │ │ ┌───────────────────────────────┐ │ │
│ │ └───────────────────────────────┘ │ │ └───────────────────────────────┘ │ │
│ │ [ diagnosis card ]                │ │                                    │ │
│ └───────────────────────────────────┘ └────────────────────────────────────┘ │
│   The counter resets at the edge, so a burst on    ← handwritten note         │
│   either side gets two windows' worth.                                       │
│ ┌ 2 VARIANTS · SEED 42 · T 64.2s · 1× · 18,204 EVENTS ┐                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: three islands spaced `--sp-3` from the viewport edges. On the left, the name and a Scenario picker. In the middle, the Demand slider, the transport buttons (play/pause, step, reset) and the speed control. On the right, Share (copies the URL state) and a menu (theme, export JSON, about, the "what this models and leaves out" note).
- **Variant panels**: two or three equal columns, each an island. Order inside a panel: a header (Variant label, plus pills for algorithm and key scope), the pipeline strip, the stat row, the charts, then the diagnosis slot. Panels line up vertically, so the same chart sits at the same height in every column and can be compared at a glance.
- **Notes** sit on the paper below or between the panels, never inside an island.
- **Ledger** at the bottom-left.

### Mobile (below 640px)

Following Breakscale's mobile layout:
- The top bar collapses to the name, undo/redo and Share. Demand and the headline stat move into a strip beneath it, with the slider full width underneath.
- Only one Variant is visible at a time. A bottom tab bar (height 56px, icons with labels) switches between Variants, with a final **Compare** tab that shows every Variant's stat row in a stack.
- Charts keep their full width. Notes wrap under the charts.
- Keep a 16px gutter, and never scroll horizontally.

From 640 to 1023px, stack the Variant panels vertically at full width.

## Charts

Hand-drawn SVG polylines, with no chart library.

- **Plot area**: `--surface`, no border. Horizontal gridlines only, 1px `--grid-major`. Axis labels in label type, placed at the right edge. The time axis shows the last 60 simulated seconds and scrolls left.
- **Series**: 1.5px strokes with round joins and `vector-effect: non-scaling-stroke`.
  - Allowed: kind-limiter `-stroke`. Rejected: `--danger-mark`. Delayed: kind-queue `-stroke`.
  - Latency percentiles are one ramp: p50 `--line-3`, p95 `--line-4`, p99 `--text-dim` at 2px.
  - Offered Load: `--accent`. Demand: dashed `--line-3`, so the gap between them is the Retry Amplification.
- **Reference lines**: the configured limit, and the Baseline p99, as dashed `--line-2` with a mono label at the right end.
- **Boundary burst**: the main chart is **allowed Attempts in the last window**, a rolling count sampled every tenth of a window. Plotting per-second buckets would hide the 2x. When the count crosses the limit, fill the area above the limit line with `--danger-soft` and label the peak ratio (`2.0×`).
- **Diagnosis marker**: a vertical 1px `--danger-mark` line at the Finding's `startedAt`, with a small pill at the top naming the Failure Mode. Clicking it scrolls to the card.
- **Warm-up**: shade the first 5 seconds with `--surface-2` and put a WARM-UP pill on it.
- **Legend**: inline at the top-left, as a short line swatch plus a label per series. Never rely on colour alone: every series is also named in the legend and in the tooltip.
- **Hover**: a vertical crosshair in `--line-2`, and a small island tooltip listing each series' value in mono.

## Motion

- Hover and press take `--dur-fast`; panels and cards take `--dur-base` to `--dur-slow`, using `--ease` (`--ease-out` for things entering).
- Only `opacity` and `transform` animate (and `stroke-dashoffset` for edges).
- Charts redraw at about 30fps with no tweening between samples. Numbers update in place; tabular figures stop them jittering.
- Under `prefers-reduced-motion: reduce`: edge dashes stop, cards appear without sliding, and charts still update (they're data, not decoration).

## Accessibility

- Contrast: body text on `--bg` and `--surface` must pass WCAG AA in both themes. `--text-faint` is for labels only, never for values.
- Focus: a 2px `--accent-ring` outline offset by 2px on every interactive element. Never remove it without replacing it.
- The Demand slider is a native `input[type=range]` with `aria-valuetext` giving the real rate ("120 requests per second"), since the scale is logarithmic.
- Every chart has an `aria-label` summarising its current state ("Allowed in last window: 196, limit 100"), and each panel's stat row is real text.
- State is never shown by colour alone: failing nodes also say FAILING, and Findings carry a label and a pill.
- Hit targets are at least 32px on desktop and 44px on touch.

## What not to borrow

- Breakscale's node palette and component search: Ratescale has a fixed pipeline, so there's nothing to drag or search.
- Canvas pan, zoom and selection hints ("SCROLL TO PAN"): there is no canvas.
- Breakscale's name, logo, wording and structured-data text: only the visual style is shared.
