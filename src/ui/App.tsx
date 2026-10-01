import { useCallback, useId, useState, type CSSProperties } from 'react'
import type { Scenario } from '../runner/scenario.ts'
import { demandAt } from './controls/demand.ts'
import { withRetryMode, withVariantRetry, type RetryMode } from './controls/retry-options.ts'
import { TopBarControls } from './controls/TopBarControls.tsx'
import { ledgerLine, SLOWER_NOTICE } from './ledger.ts'
import { VariantPanel } from './panel/VariantPanel.tsx'
import { SCENARIOS } from './scenarios/index.ts'
import { useRunner } from './use-runner.ts'
import './app.css'

/**
 * The page. Picking a Scenario starts it fresh: the run is keyed by the Scenario's id, so a new
 * one gets a new runner, with nothing carried over.
 */
export function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const picked = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]
  return <ScenarioRun key={picked.id} initial={picked} onPick={setScenarioId} />
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
  const { view, controls, slower } = useRunner(initial)
  /** Restarts the run on `next`, then shows it; the runner throws first if `next` cannot run. */
  const restartWith = useCallback(
    (next: Scenario) => {
      controls.restart(next)
      setScenario(next)
    },
    [controls],
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
        {/* Share and the menu (RS-21) go after these. */}
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
        />
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
