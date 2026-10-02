import { useEffect, useState } from 'react'
import { createRunner, type RunnerView, type Speed } from '../runner/runner.ts'
import type { Scenario } from '../runner/scenario.ts'
import type { ControlChange } from '../sim/index.ts'
import { createPendingDemand } from './controls/pending-demand.ts'
import { createFrameClock } from './frame-clock.ts'
import { hiddenNotice, NO_NOTICE, type HiddenNoticeState } from './hidden-notice.ts'
import { createSlowdownHold } from './ledger.ts'

/**
 * What the burst button does (.scratch/controls/spec.md decision 2): 5x Demand for 2 s, so
 * Backend overload's default 10 per second becomes 50 for long enough to see each Limiter pace it.
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
 * `hiddenNotice` says whether to show that the run stood still while the tab was hidden
 * (hidden-notice.ts); any control dismisses it.
 */
export function useRunner(scenario: Scenario): {
  readonly view: RunnerView
  readonly controls: RunnerControls
  readonly slower: boolean
  readonly hiddenNotice: boolean
} {
  const [runner] = useState(() => createRunner(scenario))
  const [pending] = useState(createPendingDemand)
  /** The hidden-tab notice, changed by visibility, controls and frames; published with the view. */
  const [notice] = useState<{ state: HiddenNoticeState }>(() => ({ state: NO_NOTICE }))
  /** Runs a control, which dismisses the hidden-tab notice. */
  const control =
    <A extends unknown[]>(act: (...args: A) => void) =>
    (...args: A) => {
      notice.state = hiddenNotice(notice.state, { kind: 'control' })
      act(...args)
    }
  const [controls] = useState<RunnerControls>(() => ({
    setDemand: control((demandRps: number) => pending.set(demandRps)),
    burst: control(() => runner.applyControl(BURST)),
    play: control(() => runner.resume()),
    pause: control(() => runner.pause()),
    step: control(() => runner.step()),
    // A slider value still waiting would otherwise land at 0 of the new run, as a live change
    // nobody made there.
    reset: control(() => {
      pending.take()
      runner.reset()
    }),
    setSpeed: control((speed: Speed) => runner.setSpeed(speed)),
    restart: control((next: Scenario) => {
      runner.restart(next)
      pending.take()
    }),
  }))
  const [view, setView] = useState(() => runner.view())
  const [slower, setSlower] = useState(false)
  const [showNotice, setShowNotice] = useState(false)

  useEffect(() => {
    // A handle for checking the app from the browser console or a test script; dev builds only.
    if (import.meta.env.DEV) Object.assign(window, { ratescale: runner })
    const clock = createFrameClock()
    const hold = createSlowdownHold()
    // A background tab gets no frames at all, so the first frame back would see the whole
    // hidden time; restarting on every visibility change makes that frame count 0 instead.
    const restart = () => {
      clock.restart()
      const view = runner.view()
      notice.state = hiddenNotice(
        notice.state,
        document.visibilityState === 'hidden'
          ? { kind: 'hidden', playing: !view.paused }
          : { kind: 'visible', simMs: view.simMs },
      )
    }
    document.addEventListener('visibilitychange', restart)
    // The view is published about 30 times a second even while paused, so a control pressed
    // then shows within a frame or two without publishing on its own.
    let frame = requestAnimationFrame(function onFrame(nowMs) {
      const demandRps = pending.take()
      if (demandRps !== null) runner.applyControl({ kind: 'demand', demandRps })
      hold.frame(nowMs, runner.tick(clock.step(nowMs, document.visibilityState === 'visible')))
      if (clock.shouldPublish(nowMs)) {
        const view = runner.view()
        notice.state = hiddenNotice(notice.state, { kind: 'tick', simMs: view.simMs })
        setView(view)
        setSlower(hold.showing(nowMs))
        setShowNotice(notice.state.shownAtMs !== null)
      }
      frame = requestAnimationFrame(onFrame)
    })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [runner, pending, notice])

  return { view, controls, slower, hiddenNotice: showNotice }
}
