import { describe, expect, it } from 'vitest'
import { createSlowdownHold, ledgerLine, SLOWER_HOLD_MS } from '../src/ui/ledger.ts'

describe('ledgerLine', () => {
  it('reads as DESIGN.md writes it', () => {
    expect(
      ledgerLine({ variants: 3, seed: 42, simMs: 64_230, speed: 1, eventsHandled: 18_204 }),
    ).toBe('3 VARIANTS · SEED 42 · T 64.2s · 1× · 18,204 EVENTS')
  })

  it('handles one Variant, the start of a run, half speed and big counts', () => {
    expect(ledgerLine({ variants: 1, seed: 7, simMs: 0, speed: 0.5, eventsHandled: 0 })).toBe(
      '1 VARIANT · SEED 7 · T 0.0s · 0.5× · 0 EVENTS',
    )
    expect(
      ledgerLine({ variants: 2, seed: 1, simMs: 3_600_000, speed: 10, eventsHandled: 1_234_567 }),
    ).toBe('2 VARIANTS · SEED 1 · T 3,600.0s · 10× · 1,234,567 EVENTS')
  })
})

describe('createSlowdownHold', () => {
  it('shows the notice from a frame that hit the budget until SLOWER_HOLD_MS after the last one', () => {
    const hold = createSlowdownHold()
    expect(hold.showing(0)).toBe(false)
    hold.frame(1000, true)
    hold.frame(1016, false)
    // The frames between two publishes alternate; the notice stays up rather than flickering.
    expect(hold.showing(1033)).toBe(true)
    hold.frame(1050, true)
    expect(hold.showing(1050 + SLOWER_HOLD_MS - 1)).toBe(true)
    expect(hold.showing(1050 + SLOWER_HOLD_MS)).toBe(false)
  })
})
