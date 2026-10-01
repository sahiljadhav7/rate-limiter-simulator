import { useEffect, useState } from 'react'
import { createRunner, type RunnerView, type Speed } from '../runner/runner.ts'
import type { Scenario } from '../runner/scenario.ts'
import type { ControlChange } from '../sim/index.ts'
import { createPendingDemand } from './controls/pending-demand.ts'
import { createFrameClock } from './frame-clock.ts'
import { createSlowdownHold } from './ledger.ts'

/**
 * What the burst button does (.scratch/controls/spec.md decision 2): 5x Demand for 2 s, enough
 * to take the Edge burst Scenario's 4 per second to twice its limit of 10.
 */
export const BURST: ControlChange = { kind: 'burst', multiplier: 5, durationMs: 2000 }

/** What the controls call. Each is made once, so passing them down never re-renders a child. */
export interface RunnerControls {
  /** Asks for a new Demand, applied before the next frame's tick; the newest in a frame wins. */
  setDemand(demandRps: number): void
  burst(): void
  play(): void
  pause(): void
  /** One simulated second, while paused. */
  step(): void
  reset(): void
  setSpeed(speed: Speed): void
  /** Starts the edited Scenario fresh from 0, with no live change replayed. */
  restart(scenario: Scenario): void
}

/**
 * Runs `scenario` in the browser: one runner for the component's lifetime, ticked every
 * animation frame with that frame's wall time, and its view copied into React state about 30
 * times a second. While the tab is hidden the run does not move, and the hidden time is never
 * counted (CLAUDE.md "A backgrounded browser tab suspends requestAnimationFrame").
 *
 * The Scenario is read once; a new Scenario needs a new component (a `key`). The runner is
 * made once by a lazy `useState`, which keeps it for the component's lifetime as a ref would,
 * and the controls reach it through `controls`. `slower` says whether to show the ledger's
 * RUNNING SLOWER THAN REQUESTED, from every frame rather than only the published ones.
 */
export function useRunner(scenario: Scenario): {
  readonly view: RunnerView
  readonly controls: RunnerControls
  readonly slower: boolean
} {
  const [runner] = useState(() => createRunner(scenario))
  const [pending] = useState(createPendingDemand)
  const [controls] = useState<RunnerControls>(() => ({
    setDemand: (demandRps) => pending.set(demandRps),
    burst: () => runner.applyControl(BURST),
    play: () => runner.resume(),
    pause: () => runner.pause(),
    step: () => runner.step(),
    // A slider value still waiting would otherwise land at 0 of the new run, as a live change
    // nobody made there.
    reset: () => {
      pending.take()
      runner.reset()
    },
    setSpeed: (speed) => runner.setSpeed(speed),
    restart: (next) => {
      runner.restart(next)
      pending.take()
    },
  }))
  const [view, setView] = useState(() => runner.view())
  const [slower, setSlower] = useState(false)

  useEffect(() => {
    // A handle for checking the app from the browser console or a test script; dev builds only.
    if (import.meta.env.DEV) Object.assign(window, { ratescale: runner })
    const clock = createFrameClock()
    const hold = createSlowdownHold()
    // A background tab gets no frames at all, so the first frame back would see the whole
    // hidden time; restarting on every visibility change makes that frame count 0 instead.
    const restart = () => clock.restart()
    document.addEventListener('visibilitychange', restart)
    // The view is published about 30 times a second even while paused, so a control pressed
    // then shows within a frame or two without publishing on its own.
    let frame = requestAnimationFrame(function onFrame(nowMs) {
      const demandRps = pending.take()
      if (demandRps !== null) runner.applyControl({ kind: 'demand', demandRps })
      hold.frame(nowMs, runner.tick(clock.step(nowMs, document.visibilityState === 'visible')))
      if (clock.shouldPublish(nowMs)) {
        setView(runner.view())
        setSlower(hold.showing(nowMs))
      }
      frame = requestAnimationFrame(onFrame)
    })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [runner, pending])

  return { view, controls, slower }
}
