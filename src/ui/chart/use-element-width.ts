import { useCallback, useState } from 'react'

/**
 * The content width of an element, in px, kept up to date by a ResizeObserver: 0 until it has
 * been measured. Attach the returned callback as the element's `ref`; the observer stops when the
 * element unmounts (a React 19 ref cleanup).
 */
export function useElementWidth<E extends Element>(): readonly [
  (element: E | null) => (() => void) | undefined,
  number,
] {
  const [width, setWidth] = useState(0)
  const ref = useCallback((element: E | null) => {
    if (element === null) return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
