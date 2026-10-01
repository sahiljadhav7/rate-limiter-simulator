/**
 * The wall-clock side of the frame loop, kept pure so it can be tested: how much wall time
 * each animation frame hands the runner, and when to copy the runner's view into React state.
 */

/** How often the view is copied into React state, in ms: about 30 times a second (DESIGN.md). */
export const PUBLISH_MS = 1000 / 30

/**
 * Frames do not land exactly on the 60 fps grid, so a publish is due a little early rather than
 * one frame late, which would halve the rate to 20 a second.
 */
export const FRAME_SLACK_MS = 2

/** Turns animation-frame timestamps into wall time for the runner. */
export interface FrameClock {
  /**
   * The wall time to pass to `runner.tick` for a frame at `nowMs` (the requestAnimationFrame
   * timestamp). 0 for the first frame, and for any frame while the tab is hidden; the first
   * visible frame after that is 0 again, so time spent hidden never counts.
   */
  step(nowMs: number, visible: boolean): number
  /** Whether the frame at `nowMs` should publish the view. True for the first frame. */
  shouldPublish(nowMs: number): boolean
  /** Forgets the last frame, so the next one gives 0, as after a pause. */
  restart(): void
}

/** A frame clock that has seen no frame yet. */
export function createFrameClock(): FrameClock {
  let lastFrameMs: number | null = null
  let lastPublishMs: number | null = null
  return {
    step(nowMs, visible) {
      if (!visible) {
        lastFrameMs = null
        return 0
      }
      const wallMs = lastFrameMs === null ? 0 : Math.max(0, nowMs - lastFrameMs)
      lastFrameMs = nowMs
      return wallMs
    },
    shouldPublish(nowMs) {
      if (lastPublishMs !== null && nowMs - lastPublishMs < PUBLISH_MS - FRAME_SLACK_MS) {
        return false
      }
      lastPublishMs = nowMs
      return true
    },
    restart() {
      lastFrameMs = null
    },
  }
}
