import { describe, expect, it } from 'vitest'
import { createPendingDemand } from '../src/ui/controls/pending-demand.ts'

describe('createPendingDemand', () => {
  it('gives nothing until the slider moves, then the newest value once', () => {
    const pending = createPendingDemand()
    expect(pending.take()).toBeNull()
    // Three input events in one frame become one Demand change, the newest.
    pending.set(5)
    pending.set(8)
    pending.set(12)
    expect(pending.take()).toBe(12)
    expect(pending.take()).toBeNull()
  })
})
