import { useRef, type KeyboardEvent } from 'react'
import type { LimiterSpec, Severity } from '../../sim/index.ts'
import { movedTab } from './tabs.ts'
import './tabs.css'

/** A Limiter algorithm's tab icon, 20px, drawn in the limiter kind's stroke colour. */
function AlgorithmIcon(props: { readonly algo: LimiterSpec['algo'] }) {
  switch (props.algo) {
    // A window moving along the time axis.
    case 'sliding-counter':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="4" width="10" height="8" rx="1.5" />
          <path d="M2.5 16h15M14.5 13.5l3 2.5-3 2.5" />
        </svg>
      )
    // A bucket with a token dropping in.
    case 'token-bucket':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 8h12l-1.5 9h-9z" />
          <circle cx="10" cy="3.5" r="1.5" />
        </svg>
      )
  }
}

/** The Compare tab's icon: Variants side by side. */
function CompareIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="4" width="6" height="12" rx="1" />
      <rect x="11.5" y="4" width="6" height="12" rx="1" />
    </svg>
  )
}

/** One Variant's tab, as the bar draws it. */
export interface VariantTab {
  readonly name: string
  /** The Variant's full label, its tab's accessible name. */
  readonly label: string
  readonly algo: LimiterSpec['algo']
  /** The id of the panel it opens. */
  readonly panelId: string
  readonly badge: Severity | null
}

const BADGE_WORDS: Readonly<Record<Severity, string>> = { warn: 'warning', broken: 'broken' }

/**
 * The phone's bottom tab bar (DESIGN.md "Mobile"): one tab per Variant, then Compare. A
 * WAI-ARIA tablist: the open tab is the only one in the Tab order, and the arrow keys, Home and
 * End move between tabs and open them. CSS shows it below 640px only.
 */
export function TabBar(props: {
  readonly tabs: readonly VariantTab[]
  readonly compareId: string
  /** The open tab: a Variant's index, or `tabs.length` for Compare. */
  readonly open: number
  readonly onOpen: (index: number) => void
}) {
  const { tabs, compareId, open, onOpen } = props
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const count = tabs.length + 1
  const onKeyDown = (event: KeyboardEvent) => {
    const next = movedTab(open, event.key, count)
    if (next === null) return
    event.preventDefault()
    onOpen(next)
    buttons.current[next]?.focus()
  }
  const tab = (index: number, controls: string, label: string) => ({
    ref: (el: HTMLButtonElement | null) => {
      buttons.current[index] = el
    },
    type: 'button' as const,
    role: 'tab',
    className: 'tab',
    'aria-selected': open === index,
    'aria-controls': controls,
    'aria-label': label,
    tabIndex: open === index ? 0 : -1,
    onClick: () => onOpen(index),
  })
  return (
    <div className="tab-bar" role="tablist" aria-label="Variants" onKeyDown={onKeyDown}>
      {tabs.map((t, i) => (
        <button
          key={t.panelId}
          {...tab(i, t.panelId, t.badge ? `${t.label}, ${BADGE_WORDS[t.badge]}` : t.label)}
        >
          <span className="tab-icon" data-kind="limiter">
            <AlgorithmIcon algo={t.algo} />
            {t.badge ? <span className="tab-badge" data-state={t.badge} /> : null}
          </span>
          <span className="tab-name" aria-hidden="true">
            {t.name}
          </span>
        </button>
      ))}
      <button {...tab(tabs.length, compareId, 'Compare')}>
        <span className="tab-icon">
          <CompareIcon />
        </span>
        <span className="tab-name" aria-hidden="true">
          Compare
        </span>
      </button>
    </div>
  )
}
