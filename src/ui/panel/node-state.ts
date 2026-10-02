/**
 * Which pipeline node a Finding is about, and how the node shows it. Colour comes only from
 * Findings, which come only from measured Snapshots (CLAUDE.md "The one rule"), and the word
 * says it too, so state never rests on colour alone (DESIGN.md "Accessibility").
 */
import type { FailureMode, Finding, Severity } from '../../sim/index.ts'

export type PipelineNode = 'client' | 'limiter' | 'backend'

/**
 * The node each Failure Mode is about: saturation, queue overflow and goodput collapse are the
 * Backend busy and losing work; a boundary burst and a limit too loose are the Limiter letting
 * too much through, and a limit too tight is it turning too much away; a retry storm and a noisy
 * neighbor are the Clients sending more.
 */
const NODE_OF: Readonly<Record<FailureMode, PipelineNode>> = {
  saturation: 'backend',
  'queue-overflow': 'backend',
  'boundary-burst': 'limiter',
  'retry-storm': 'client',
  'limit-too-loose': 'limiter',
  'limit-too-tight': 'limiter',
  'goodput-collapse': 'backend',
  'noisy-neighbor': 'client',
}

const WORD: Readonly<Record<Severity, string>> = { warn: 'STRUGGLING', broken: 'FAILING' }

/** How a node looks: its worst Finding's severity and word, and the share it lost, if any. */
export interface NodeState {
  readonly severity: Severity | null
  readonly word: string | null
  /** The Finding's Lost evidence, as it shows it, such as "24.0%". */
  readonly lost: string | null
}

export function nodeState(findings: readonly Finding[], node: PipelineNode): NodeState {
  const mine = findings.filter((finding) => NODE_OF[finding.id] === node)
  const worst = mine.find((f) => f.severity === 'broken') ?? mine[0]
  if (worst === undefined) return { severity: null, word: null, lost: null }
  return {
    severity: worst.severity,
    word: WORD[worst.severity],
    // From whichever Finding measured it: the worst may be one without a Lost share.
    lost: mine.flatMap((f) => f.evidence).find((e) => e.metric === 'Lost')?.value ?? null,
  }
}
