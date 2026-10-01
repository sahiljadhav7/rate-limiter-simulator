import type { CSSProperties } from 'react'
import { edgeBurstScenario } from './edge-burst-scenario.ts'
import { ledgerLine, SLOWER_NOTICE } from './ledger.ts'
import { VariantPanel } from './panel/VariantPanel.tsx'
import { useRunner } from './use-runner.ts'
import './app.css'

// Until the Scenario picker (RS-18): the Edge burst Scenario, one panel per Variant.
const scenario = edgeBurstScenario

export function App() {
  const { view, slower } = useRunner(scenario)
  return (
    <div className="page">
      <header className="top-bar">
        {/* The Demand, transport and speed island (RS-18) and Share (RS-21) go beside this. */}
        <div className="island top-bar-name">
          <span className="app-name">Ratescale</span>
          <span className="scenario-title">{scenario.title}</span>
        </div>
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
