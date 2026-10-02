import { useCallback, useSyncExternalStore } from 'react'

/** Whether `query` matches now, re-rendering when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

/** The phone layout's media query (DESIGN.md "Mobile": below 640px). */
export const PHONE_QUERY = '(max-width: 639px)'
