import { useEffect, useId, useRef, useState } from 'react'
import './share.css'

/** How long "Link copied" stays, in ms. */
const COPIED_MS = 2000

/**
 * The top bar's right island (.scratch/ship/spec.md decision 7): Share copies the link to this
 * setup. Without a clipboard (an insecure page, or permission denied) it shows the link in a
 * read-only field, selected, so the student can copy it themselves.
 */
export function ShareButton(props: { readonly url: string }) {
  const { url } = props
  const fieldId = useId()
  /** How many times the link has been copied; each copy restarts the 2 s of "Link copied". */
  const [copies, setCopies] = useState(0)
  const [copied, setCopied] = useState(false)
  /** The link shown for copying by hand, or null while the clipboard works. */
  const [manual, setManual] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (copies === 0) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copies])

  useEffect(() => {
    if (manual === null) return
    field.current?.focus()
    field.current?.select()
  }, [manual])

  async function share() {
    const link = url
    try {
      // Missing outside a secure page, so the call itself can throw as well as reject.
      await navigator.clipboard.writeText(link)
      setManual(null)
      setCopied(true)
      setCopies((n) => n + 1)
    } catch {
      setCopied(false)
      setManual(link)
    }
  }

  return (
    <div className="island top-bar-share">
      <button type="button" className="btn" onClick={() => void share()}>
        Share
      </button>
      {manual !== null ? (
        <>
          <label className="visually-hidden" htmlFor={fieldId}>
            Link to this setup
          </label>
          <input
            id={fieldId}
            ref={field}
            className="field share-link"
            readOnly
            value={manual}
            onFocus={(event) => event.currentTarget.select()}
          />
        </>
      ) : null}
      {/* Always present, so a screen reader announces the message when it appears. */}
      <span className="share-message" role="status">
        {copied ? 'Link copied' : manual !== null ? 'Copy this link' : null}
      </span>
    </div>
  )
}
