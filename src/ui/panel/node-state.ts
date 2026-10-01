/**
 * Which pipeline node a Finding is about, and how the node shows it. Colour comes only from
 * Findings, which come only from measured Snapshots (CLAUDE.md "The one rule"), and the word
 * says it too, so state never rests on colour alone (DESIGN.md "Accessibility").
 */
import type { FailureMode, Finding, Severity } from '../../sim/index.ts'

export type PipelineNode = 'client' | 'limiter' | 'backend'

/** The node each Failure Mode is about: queue overflow is the Backend losing work. */
const NODE_OF: Readonly<Record<FailureMode, PipelineNode>> = {
  'queue-overflow': 'backend',
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
    lost: worst.evidence.find((e) => e.metric === 'Lost')?.value ?? null,
  }
}
