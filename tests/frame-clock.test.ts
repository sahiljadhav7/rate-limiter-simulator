import { describe, expect, it } from 'vitest'
import { createFrameClock, FRAME_SLACK_MS, PUBLISH_MS } from '../src/ui/frame-clock.ts'

describe('createFrameClock', () => {
  it('gives 0 for the first frame, then the time since the last frame', () => {
    const clock = createFrameClock()
    expect(clock.step(1000, true)).toBe(0)
    expect(clock.step(1016, true)).toBe(16)
    expect(clock.step(1050, true)).toBe(34)
  })

  it('gives 0 while the tab is hidden, and does not count the hidden time afterwards', () => {
    const clock = createFrameClock()
    clock.step(1000, true)
    clock.step(1016, true)
    expect(clock.step(1032, false)).toBe(0)
    expect(clock.step(61_032, false)).toBe(0)
    // Back after a minute: the first visible frame starts counting again from here.
    expect(clock.step(61_048, true)).toBe(0)
    expect(clock.step(61_064, true)).toBe(16)
  })

  it('starts counting again after a restart, as after a pause', () => {
    const clock = createFrameClock()
    clock.step(1000, true)
    clock.restart()
    expect(clock.step(5000, true)).toBe(0)
    expect(clock.step(5016, true)).toBe(16)
  })

  it('says to publish the view about 30 times a second, on the first frame and then every PUBLISH_MS', () => {
    const clock = createFrameClock()
    const published: number[] = []
    // 60 fps for one second.
    for (let i = 0; i <= 60; i++) {
      const now = 1000 + (i * 1000) / 60
      clock.step(now, true)
      if (clock.shouldPublish(now)) published.push(now)
    }
    expect(published[0]).toBe(1000)
    expect(published.length).toBeGreaterThanOrEqual(29)
    expect(published.length).toBeLessThanOrEqual(31)
    for (let i = 1; i < published.length; i++) {
      expect((published[i] as number) - (published[i - 1] as number)).toBeGreaterThanOrEqual(
        PUBLISH_MS - FRAME_SLACK_MS,
      )
    }
  })
})
