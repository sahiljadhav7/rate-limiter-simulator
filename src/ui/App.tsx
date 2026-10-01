import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from 'react'
import type { Scenario } from '../runner/scenario.ts'
import { demandAt } from './controls/demand.ts'
import { withRetryMode, withVariantRetry, type RetryMode } from './controls/retry-options.ts'
import { TopBarControls } from './controls/TopBarControls.tsx'
import { ledgerLine, SLOWER_NOTICE } from './ledger.ts'
import { VariantPanel } from './panel/VariantPanel.tsx'
import { SCENARIOS } from './scenarios/index.ts'
import { ShareButton } from './share/ShareButton.tsx'
import { parseShareState, shareUrl } from './share/url-state.ts'
import { useRunner, type RunnerControls } from './use-runner.ts'
import './app.css'

/**
 * The Scenario the page opens with: the one the address bar's link sets up, at its seed, Retry
 * Policies and Demand, from T 0 (.scratch/ship/spec.md decision 2). The link's Demand becomes
 * the Scenario's own, so the run starts there and Reset returns there.
 */
function linkedScenario(): Scenario {
  const { scenario, demandRps } = parseShareState(window.location.search, SCENARIOS)
  return { ...scenario, traffic: { ...scenario.traffic, demandRps } }
}

/**
 * The page. Picking a Scenario starts it fresh: the run is keyed by the Scenario's id, so a new
 * one gets a new runner, with nothing carried over.
 */
export function App() {
  const [picked, setPicked] = useState(linkedScenario)
  const onPick = useCallback((scenarioId: string) => {
    setPicked(SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0])
  }, [])
  return <ScenarioRun key={picked.id} initial={picked} onPick={onPick} />
}

/**
 * One Scenario running, one panel per Variant. The Scenario is state because a seed or Retry
 * Policy change edits it and restarts the run.
 */
function ScenarioRun(props: {
  readonly initial: Scenario
  readonly onPick: (scenarioId: string) => void
}) {
  const { initial, onPick } = props
  const pickerId = useId()
  const [scenario, setScenario] = useState<Scenario>(initial)
  const { view, controls: runnerControls, slower } = useRunner(initial)
  /**
   * The Demand the address bar holds: where the slider was last released, or where Reset put
   * it. Not the live value, which changes every frame of a drag.
   */
  const [linkDemand, setLinkDemand] = useState(initial.traffic.demandRps)
  const controls = useMemo<RunnerControls>(
    () => ({
      ...runnerControls,
      reset: () => {
        runnerControls.reset()
        setLinkDemand(initial.traffic.demandRps)
      },
    }),
    [runnerControls, initial],
  )
  // The address bar follows the setup, so a reload or a copied address reopens it (decision 6).
  useEffect(() => {
    window.history.replaceState(null, '', shareUrl(window.location.href, scenario, linkDemand))
  }, [scenario, linkDemand])
  const link = useCallback(
    () => shareUrl(window.location.href, scenario, linkDemand),
    [scenario, linkDemand],
  )
  /** Restarts the run on `next`, then shows it; the runner throws first if `next` cannot run. */
  const restartWith = useCallback(
    (next: Scenario) => {
      runnerControls.restart(next)
      setScenario(next)
    },
    [runnerControls],
  )
  const onSeed = useCallback(
    (seed: number) => restartWith({ ...scenario, seed }),
    [restartWith, scenario],
  )
  const onRetryMode = useCallback(
    (index: number, mode: RetryMode) => {
      const retry = scenario.variants[index]?.retry
      if (retry) restartWith(withVariantRetry(scenario, index, withRetryMode(retry, mode)))
    },
    [restartWith, scenario],
  )
  return (
    // A paused run stops a failing node shaking too: the shake is the only thing that moves.
    <div className="page" data-paused={view.paused || undefined}>
      <header className="top-bar">
        <div className="island top-bar-name">
          <span className="app-name">Ratescale</span>
          <label className="visually-hidden" htmlFor={pickerId}>
            Scenario
          </label>
          <select
            id={pickerId}
            className="field scenario-picker"
            value={scenario.id}
            onChange={(event) => onPick(event.currentTarget.value)}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
        <TopBarControls
          controls={controls}
          demandRps={demandAt(scenario.traffic.demandRps, view.timeline, view.simMs)}
          paused={view.paused}
          speed={view.speed}
          seed={scenario.seed}
          onSeed={onSeed}
          onDemandRelease={setLinkDemand}
        />
        <ShareButton url={link} />
      </header>
      <main className="panels" style={{ '--columns': scenario.variants.length } as CSSProperties}>
        {scenario.variants.map((config, i) => {
          // The runner keeps the Scenario's Variant order, so the view lines up with the config.
          const variant = view.variants[i]
          return variant ? (
            <VariantPanel
              key={config.label}
              variant={variant}
              config={config}
              backend={scenario.backend}
              clients={scenario.traffic.clients.length}
              nowMs={view.simMs}
              index={i}
              onRetryMode={onRetryMode}
            />
          ) : null
        })}
      </main>
      <footer className="ledger">
        <span data-testid="ledger-line">
          {ledgerLine({
            variants: scenario.variants.length,
            seed: scenario.seed,
            simMs: view.simMs,
            speed: view.speed,
            eventsHandled: view.eventsHandled,
          })}
        </span>
        {/* Always present, so a screen reader announces the notice when it appears. */}
        <span className="ledger-notice" role="status">
          {slower ? SLOWER_NOTICE : null}
        </span>
      </footer>
    </div>
  )
}
