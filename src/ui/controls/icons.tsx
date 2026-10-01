/** Transport icons, 16px inline SVG in the current text colour; the buttons carry the labels. */
const ICON = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true } as const

export function PlayIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
    </svg>
  )
}

export function StepIcon() {
  return (
    <svg {...ICON}>
      <path d="M3 2.5v11l7-5.5z" fill="currentColor" />
      <path d="M11 2.5h2v11h-2z" fill="currentColor" />
    </svg>
  )
}

export function ResetIcon() {
  return (
    <svg {...ICON}>
      <path
        d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M2.5 2v4h4z" fill="currentColor" />
    </svg>
  )
}
