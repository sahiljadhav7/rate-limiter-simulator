import { describe, expect, it } from 'vitest'
import { createSimClock } from '../src/sim/clock.ts'

describe('createSimClock', () => {
  it('starts at 0 ms of simulated time', () => {
    expect(createSimClock().now()).toBe(0)
  })

  it('moves to the time it is advanced to', () => {
    const clock = createSimClock()
    clock.advanceTo(250)
    expect(clock.now()).toBe(250)
    clock.advanceTo(1000.5)
    expect(clock.now()).toBe(1000.5)
  })

  // Several events can share a timestamp, so standing still is normal.
  it('allows advancing to the current time', () => {
    const clock = createSimClock()
    clock.advanceTo(500)
    expect(() => clock.advanceTo(500)).not.toThrow()
    expect(clock.now()).toBe(500)
  })

  // Time going backwards is always an engine bug, so it fails loudly and leaves the time as it was.
  it('throws when advanced to an earlier time', () => {
    const clock = createSimClock()
    clock.advanceTo(500)
    expect(() => clock.advanceTo(499.9)).toThrow(RangeError)
    expect(clock.now()).toBe(500)
  })

  // NaN compares false with everything, so it would slip past the backwards check and
  // poison every later timestamp; Infinity would end the run in one step.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects advancing to %s',
    (timeMs) => {
      const clock = createSimClock()
      clock.advanceTo(10)
      expect(() => clock.advanceTo(timeMs)).toThrow(RangeError)
      expect(clock.now()).toBe(10)
    },
  )

  it('can start at a given time and still refuses to go before it', () => {
    const clock = createSimClock(2000)
    expect(clock.now()).toBe(2000)
    expect(() => clock.advanceTo(1999)).toThrow(RangeError)
  })

  // Simulated time starts at 0 or later; a negative, NaN or infinite start is a caller bug.
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects starting at %s', (startMs) => {
    expect(() => createSimClock(startMs)).toThrow(RangeError)
  })
})
