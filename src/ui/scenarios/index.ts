import type { Scenario } from '../../runner/scenario.ts'
import { backendOverloadScenario } from './backend-overload.ts'
import { edgeBurstScenario } from './edge-burst.ts'

/** Every Scenario, in the picker's order; the first loads by default. */
export const SCENARIOS: readonly [Scenario, ...Scenario[]] = [
  backendOverloadScenario,
  edgeBurstScenario,
]
