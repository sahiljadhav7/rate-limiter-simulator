import { useEffect, useState } from 'react'
import { createRunner, type Runner, type RunnerView } from '../runner/runner.ts'
import type { Scenario } from '../runner/scenario.ts'
import { createFrameClock } from './frame-clock.ts'

/**
 * Runs `scenario` in the browser: one runner for the component's lifetime, ticked every
 * animation frame with that frame's wall time, and its view copied into React state about 30
 * times a second. While the tab is hidden the run does not move, and the hidden time is never
 * counted (CLAUDE.md "A backgrounded browser tab suspends requestAnimationFrame").
 *
 * The Scenario is read once; a new Scenario needs a new component (a `key`). The runner is
 * made once by a lazy `useState`, which keeps it for the component's lifetime as a ref would,
 * and is returned for the controls (RS-18) to call.
 */
export function useRunner(scenario: Scenario): {
  readonly view: RunnerView
  readonly runner: Runner
} {
  const [runner] = useState(() => createRunner(scenario))
  const [view, setView] = useState(() => runner.view())

  useEffect(() => {
    // A handle for checking the app from the browser console or a test script; dev builds only.
    if (import.meta.env.DEV) Object.assign(window, { ratescale: runner })
    const clock = createFrameClock()
    // A background tab gets no frames at all, so the first frame back would see the whole
    // hidden time; restarting on every visibility change makes that frame count 0 instead.
    const restart = () => clock.restart()
    document.addEventListener('visibilitychange', restart)
    let frame = requestAnimationFrame(function onFrame(nowMs) {
      runner.tick(clock.step(nowMs, document.visibilityState === 'visible'))
      if (clock.shouldPublish(nowMs)) setView(runner.view())
      frame = requestAnimationFrame(onFrame)
    })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [runner])

  return { view, runner }
}
