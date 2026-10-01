import { edgeBurstScenario } from './edge-burst-scenario.ts'
import { useRunner } from './use-runner.ts'
import { VariantCharts } from './VariantCharts.tsx'

// Until the panels and controls (RS-17, RS-18): the Edge burst Scenario's charts, one column
// per Variant.
export function App() {
  const { view } = useRunner(edgeBurstScenario)
  return (
    <main className="shell">
      <h1>Ratescale</h1>
      <p className="sim-time">
        Simulated time <span data-testid="sim-time">{(view.simMs / 1000).toFixed(1)}</span> s
      </p>
      <div className="variants">
        {edgeBurstScenario.variants.map((config, i) => {
          // The runner keeps the Scenario's Variant order, so the view lines up with the config.
          const variant = view.variants[i]
          return variant ? (
            <section key={config.label} className="variant" data-testid="variant">
              <h2>{config.label}</h2>
              <VariantCharts
                variant={variant}
                config={config}
                backend={edgeBurstScenario.backend}
                clients={edgeBurstScenario.traffic.clients.length}
                nowMs={view.simMs}
              />
            </section>
          ) : null
        })}
      </div>
    </main>
  )
}
