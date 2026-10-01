import { memo, useId, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { SPEEDS, type Speed } from '../../runner/runner.ts'
import { MAX_SEED } from '../../sim/index.ts'
import { formatNumber } from '../panel/stats.ts'
import type { RunnerControls } from '../use-runner.ts'
import { DEMAND_TICKS, demandFromPosition, positionFromDemand } from './demand.ts'
import { PauseIcon, PlayIcon, ResetIcon, StepIcon } from './icons.tsx'
import { parseSeed } from './seed.ts'
import './controls.css'

/** Slider positions per unit: fine enough that every two-significant-figure Demand is reachable. */
const SLIDER_STEPS = 1000

/**
 * The Demand slider (DESIGN.md "Slider (Demand)"): a native range on a log scale from 1 to 1,000
 * Requests per second, with the Demand in effect beside it. While the thumb moves it shows the
 * value asked for; the run applies it on the next frame. `onRelease` hears the Demand it was
 * left at, once per drag or key press.
 */
function DemandSlider(props: {
  readonly demandRps: number
  readonly onChange: (demandRps: number) => void
  readonly onRelease: (demandRps: number) => void
}) {
  const { demandRps, onChange, onRelease } = props
  const id = useId()
  /** The position being dragged, or null: the run's Demand lags a frame behind the thumb. */
  const [draft, setDraft] = useState<number | null>(null)
  const position = draft ?? positionFromDemand(demandRps)
  const shown = draft === null ? demandRps : demandFromPosition(draft)
  const release = () => {
    if (draft === null) return
    setDraft(null)
    onRelease(demandFromPosition(draft))
  }
  return (
    <div className="demand">
      <label className="demand-readout" htmlFor={id}>
        <span className="label">Demand</span>
        <span className="demand-value">{formatNumber(shown)}</span>
        <span className="unit">requests / sec</span>
      </label>
      <div className="demand-track">
        <input
          id={id}
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={Math.round(position * SLIDER_STEPS)}
          aria-valuetext={`${formatNumber(shown)} Requests per second`}
          style={{ '--fill': `${position * 100}%` } as CSSProperties}
          onChange={(event) => {
            const p = Number(event.currentTarget.value) / SLIDER_STEPS
            setDraft(p)
            onChange(demandFromPosition(p))
          }}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
        />
        <div className="demand-ticks" aria-hidden="true">
          {DEMAND_TICKS.map((tick) => (
            <span key={tick} style={{ left: `${positionFromDemand(tick) * 100}%` }}>
              {tick >= 1000 ? `${tick / 1000}k` : tick}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The seed field: applied on Enter or leaving the field; anything but a valid seed says why. */
function SeedField(props: { readonly seed: number; readonly onChange: (seed: number) => void }) {
  const { seed, onChange } = props
  const id = useId()
  const messageId = useId()
  /** What is typed, or null while the field shows the run's seed. */
  const [text, setText] = useState<string | null>(null)
  const invalid = text !== null && parseSeed(text) === null
  function apply() {
    if (text === null) return
    const next = parseSeed(text)
    if (next === null) return
    setText(null)
    if (next !== seed) onChange(next)
  }
  return (
    <div className="seed">
      <label className="label" htmlFor={id}>
        Seed
      </label>
      <input
        id={id}
        className="field seed-input"
        inputMode="numeric"
        value={text ?? String(seed)}
        aria-invalid={invalid}
        aria-describedby={invalid ? messageId : undefined}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') apply()
          if (event.key === 'Escape') setText(null)
        }}
        onBlur={apply}
      />
      {invalid ? (
        <span id={messageId} className="seed-message" role="alert">
          A whole number from 0 to {MAX_SEED.toLocaleString('en-US')}
        </span>
      ) : null}
    </div>
  )
}

/** What the top bar's controls show and call. */
export interface TopBarControlsProps {
  readonly controls: RunnerControls
  /** The Demand in effect now, in Requests per second. */
  readonly demandRps: number
  readonly paused: boolean
  readonly speed: Speed
  readonly seed: number
  /** Restarts the run with this seed. */
  readonly onSeed: (seed: number) => void
  /** The Demand the slider was released at, in Requests per second. */
  readonly onDemandRelease: (demandRps: number) => void
}

/**
 * The top bar's middle island (DESIGN.md "Top bar"): Demand, play/pause, step and reset, speed,
 * the burst button and the seed. Demand and the burst go into the control timeline; the rest
 * change when simulated time moves, or restart the run.
 */
export const TopBarControls = memo(function TopBarControls(props: TopBarControlsProps) {
  const { controls, demandRps, paused, speed, seed, onSeed, onDemandRelease } = props
  return (
    <div className="island top-bar-controls" role="group" aria-label="Controls">
      <DemandSlider
        demandRps={demandRps}
        onChange={controls.setDemand}
        onRelease={onDemandRelease}
      />
      <div className="button-group" role="group" aria-label="Playback">
        <button
          type="button"
          className="btn btn-icon"
          aria-label={paused ? 'Play' : 'Pause'}
          onClick={paused ? controls.play : controls.pause}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Step one simulated second"
          title="Step one simulated second (while paused)"
          disabled={!paused}
          onClick={controls.step}
        >
          <StepIcon />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Reset to 0"
          title="Reset to 0"
          onClick={controls.reset}
        >
          <ResetIcon />
        </button>
      </div>
      <div className="button-group" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="btn btn-segment"
            aria-pressed={s === speed}
            onClick={() => controls.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        title="5 times the Demand for 2 simulated seconds"
        onClick={controls.burst}
      >
        Burst 5× for 2 s
      </button>
      <SeedField seed={seed} onChange={onSeed} />
    </div>
  )
})
