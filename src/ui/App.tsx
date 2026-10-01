import { useCallback, useState, type CSSProperties } from 'react'
import type { Scenario } from '../runner/scenario.ts'
import { demandAt } from './controls/demand.ts'
import { withRetryMode, withVariantRetry, type RetryMode } from './controls/retry-options.ts'
import { TopBarControls } from './controls/TopBarControls.tsx'
import { edgeBurstScenario } from './scenarios/edge-burst.ts'
import { ledgerLine, SLOWER_NOTICE } from './ledger.ts'
import { VariantPanel } from './panel/VariantPanel.tsx'
import { useRunner } from './use-runner.ts'
import './app.css'

/**
 * The page: the Edge burst Scenario until the Scenario picker (RS-19a), one panel per Variant.
 * The Scenario is state because a seed or Retry Policy change edits it and restarts the run.
 */
export function App() {
  const [scenario, setScenario] = useState<Scenario>(edgeBurstScenario)
  const { view, controls, slower } = useRunner(edgeBurstScenario)
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
    <div className="page">
      <header className="top-bar">
        {/* Share and the menu (RS-21) go after these. */}
        <div className="island top-bar-name">
          <span className="app-name">Ratescale</span>
          <span className="scenario-title">{scenario.title}</span>
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
