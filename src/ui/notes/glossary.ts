/**
 * What each number on the page means, in plain words, for the "What the numbers mean" list under
 * the notes (ticket 06, BaseConcept "Metrics glossary"). Terms are the page's labels, or the
 * short name several labels share (p50, p95 and p99); the words follow CONTEXT.md, and
 * tests/scenario-text.test.ts checks them against its avoided words. Each says what the number
 * is and why it matters. The spans come from the constants the numbers are computed with, so the
 * text cannot drift from them.
 */
import { DIAGNOSIS_WINDOW_SNAPSHOTS, PERCENTILE_WINDOW_MS, SNAPSHOT_MS } from '../../sim/index.ts'
import { STAT_SNAPSHOTS } from '../panel/stats.ts'

/** One term and its definition. */
export interface GlossaryEntry {
  readonly term: string
  readonly definition: string
}

/** The span the stat row and the pipeline cover, in words. */
const STAT_SPAN = `the last ${(STAT_SNAPSHOTS * SNAPSHOT_MS) / 1000} seconds`

/** The span a Finding judges, so its shares cover, in words. */
const FINDING_SPAN = `the last ${(DIAGNOSIS_WINDOW_SNAPSHOTS * SNAPSHOT_MS) / 1000} seconds`

/** The span the latency percentiles cover, in words. */
const PERCENTILE_SPAN = `the last ${PERCENTILE_WINDOW_MS / 1000} seconds`

/** In the order a Request meets them: the Clients, the Limiter, the Backend, then the outcome. */
export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'Demand',
    definition:
      'New Requests per second that the Clients ask for, before any retries. The Demand slider sets it.',
  },
  {
    term: 'Offered Load',
    definition:
      'Attempts per second reaching the Limiter: new Requests plus their retry Attempts. Well above Demand, it means failed Attempts are coming back.',
  },
  {
    term: 'Retry Amplification',
    definition:
      'Offered Load divided by Demand: how many Attempts each new Request turns into. At 1.0× almost nobody retries; at 2.0× the traffic has doubled.',
  },
  {
    term: 'Allowed',
    definition:
      'Attempts per second the Limiter let through to the Backend. Its meter shows them against how many the limit allows a second.',
  },
  {
    term: 'Rejected',
    definition: `Attempts the Limiter turned away. The stat row and the Limiter show them as a share of Offered Load over ${STAT_SPAN}; the chart counts them each second. Turning some away protects the Backend; turning many away while it is mostly idle means the limit is too low.`,
  },
  {
    term: 'Delayed',
    definition:
      'Attempts a Limiter holds back and lets through later instead of turning them away. Neither the sliding window counter nor the token bucket does this, so the line stays at 0.',
  },
  {
    term: 'Busy',
    definition: `The share of the Backend’s slot time spent working over ${STAT_SPAN}. Near 100%, every extra Attempt has to wait for a slot.`,
  },
  {
    term: 'Most waiting',
    definition:
      'The most Attempts waiting for a Backend slot at any moment of a second: the Backend shows the latest second, the chart every second. When it reaches the queue limit, new Attempts are shed.',
  },
  {
    term: 'Shed',
    definition:
      'Attempts the Backend turned away because its queue was full. A shed Attempt fails at once, without a slot, and its Client may retry it.',
  },
  {
    term: 'Timed out',
    definition:
      'Attempts whose Client gave up waiting, after the timeout in its Retry Policy. The Backend still works on one once its turn comes.',
  },
  {
    term: 'Lost',
    definition: `On a struggling or failing Backend, the share of Attempts sent to it that were shed or timed out over ${FINDING_SPAN}.`,
  },
  {
    term: 'Wasted Work',
    definition:
      'The share of the Backend’s busy time spent on Attempts whose Client had already given up. The Backend finishes them anyway, and nobody reads the answer.',
  },
  {
    term: 'Goodput',
    definition:
      'Requests that succeeded, per second: the work that counted. A busy Backend with low Goodput can be working for Clients who are no longer waiting.',
  },
  {
    term: 'p50, p95 and p99',
    definition: `Percentiles (the p) of how long the Attempt that succeeded took, for Requests that succeeded over ${PERCENTILE_SPAN}: half within the p50, or median, 95 in 100 within the p95, and 99 in 100 within the p99. Rejected, shed and timed out Attempts are not in them; they lower Goodput instead of raising these.`,
  },
  {
    term: 'Baseline p99',
    definition:
      'The p99 the Backend’s own work would give if no Attempt ever waited for a slot, shown as its work alone. A p99 far above it means Attempts are queueing.',
  },
]
