import { useContext, useEffect, useRef } from 'react'
import { RunClockContext } from '../run-clock.ts'
import { useMediaQuery } from '../use-media-query.ts'
import { DASH_PERIOD_PX, dashPxPerWallSecond } from './edge-dashes.ts'

/**
 * Every edge strip that is moving, with its speed in px per wall second and how far it has slid
 * within one dash period. One animation-frame loop moves them all; it runs only while one moves.
 */
const moving = new Map<HTMLElement, { pxPerSecond: number; offsetPx: number }>()
let frame: number | null = null
let lastMs: number | null = null

function onFrame(nowMs: number): void {
  // A long gap (a hidden tab gets no frames) moves the dashes at most a tenth of a second.
  const seconds = lastMs === null ? 0 : Math.min(0.1, (nowMs - lastMs) / 1000)
  lastMs = nowMs
  for (const [strip, state] of moving) {
    state.offsetPx = (state.offsetPx + state.pxPerSecond * seconds) % DASH_PERIOD_PX
    strip.style.transform = `translateX(${state.offsetPx}px)`
  }
  frame = moving.size > 0 ? requestAnimationFrame(onFrame) : null
  if (frame === null) lastMs = null
}

/** Sets how fast `strip` moves; 0 stops it where it is. */
function setSpeed(strip: HTMLElement, pxPerSecond: number): void {
  if (pxPerSecond === 0) {
    moving.delete(strip)
    return
  }
  const offsetPx = moving.get(strip)?.offsetPx ?? 0
  moving.set(strip, { pxPerSecond, offsetPx })
  frame ??= requestAnimationFrame(onFrame)
}

/**
 * Moves an edge's dashes (DESIGN.md "Edge", "Motion"): its strip slides by its `transform`, at a
 * speed from the edge's rate and the run's speed, written straight to the element each frame, so
 * React renders only when the rate changes, about once a second. Still while paused and under
 * `prefers-reduced-motion`, and the loop stops when nothing moves.
 *
 * Measured in production builds, 10 simulated minutes at 10x, headless Chrome without a GPU
 * (.scratch/polish/issues/10-edge-dashes.md): about 2 points more main-thread time than no
 * dashes (13.6% against 11.4%), still 60 fps. A Web Animation of the same transform cost about 6
 * points there, and setting a custom property each frame about 4 to 14.
 */
export function useDashAnimation(ratePerSecond: number | null) {
  const strip = useRef<HTMLSpanElement>(null)
  const { speed, paused } = useContext(RunClockContext)
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  useEffect(() => {
    const el = strip.current
    if (el === null) return
    setSpeed(el, reduced ? 0 : dashPxPerWallSecond(ratePerSecond, speed, paused))
  }, [ratePerSecond, speed, paused, reduced])
  useEffect(() => {
    const el = strip.current
    return () => {
      if (el !== null) moving.delete(el)
    }
  }, [])
  return strip
}
