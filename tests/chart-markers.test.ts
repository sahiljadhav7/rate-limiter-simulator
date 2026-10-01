import { describe, expect, it } from 'vitest'
import type { Finding, PastFinding } from '../src/sim/index.ts'
import { pillLanes } from '../src/ui/chart/geometry.ts'
import { findingMarkers } from '../src/ui/panel/diagnosis-card.ts'

const finding = (fields: Partial<Finding> = {}): Finding => ({
  id: 'boundary-burst',
  label: 'Boundary burst',
  kind: 'cause',
  severity: 'broken',
  startedAt: 11_000,
  evidence: [],
  why: '',
  fixes: [],
  role: 'root-cause',
  ...fields,
})
const past = (fields: Partial<PastFinding> = {}): PastFinding => ({
  ...finding(fields),
  endedAt: 30_000,
  ...fields,
})

describe('findingMarkers', () => {
  it('marks every active and past Finding at its start, oldest first', () => {
    expect(
      findingMarkers(
        [finding({ startedAt: 41_000 })],
        [past({ id: 'retry-storm', label: 'Retry storm', startedAt: 10_000 })],
        'p',
      ),
    ).toEqual([
      { t: 10_000, label: 'Retry storm', targetId: 'p' },
      { t: 41_000, label: 'Boundary burst', targetId: 'p-boundary-burst' },
    ])
  })

  it('points an active Finding at its card and an ended one at the panel, since its card is gone', () => {
    const [ended, active] = findingMarkers([finding({ startedAt: 50_000 })], [past()], 'p')
    expect(ended?.targetId).toBe('p')
    expect(active?.targetId).toBe('p-boundary-burst')
  })
})

describe('pillLanes', () => {
  it('keeps pills that do not overlap on the first lane', () => {
    expect(
      pillLanes(
        [
          { x: 0, width: 50 },
          { x: 60, width: 50 },
        ],
        4,
      ),
    ).toEqual([0, 0])
  })

  it('moves a pill that would overlap one before it to the next free lane', () => {
    // Retry storm at 10 s and boundary burst at 11 s: about 8 px apart on a 480 px plot.
    expect(
      pillLanes(
        [
          { x: 80, width: 90 },
          { x: 88, width: 110 },
          { x: 95, width: 60 },
          { x: 300, width: 60 },
        ],
        4,
      ),
    ).toEqual([0, 1, 2, 0])
  })
})
