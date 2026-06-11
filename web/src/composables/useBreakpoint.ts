import { onScopeDispose, readonly, ref, type Ref } from 'vue'

export const BREAKPOINT_QUERIES = {
  mobile: '(max-width: 767px)',
  tablet: '(min-width: 768px) and (max-width: 1023px)',
  desktop: '(min-width: 1024px)',
} as const

export type BreakpointName = keyof typeof BREAKPOINT_QUERIES

type MediaQueryListWithLegacy = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void
}

export function useBreakpoint(queryOrName: BreakpointName | string): Readonly<Ref<boolean>> {
  const query =
    queryOrName in BREAKPOINT_QUERIES
      ? BREAKPOINT_QUERIES[queryOrName as BreakpointName]
      : queryOrName
  const matches = ref(false)

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return readonly(matches)
  }

  const mediaQuery = window.matchMedia(query) as MediaQueryListWithLegacy
  matches.value = mediaQuery.matches

  const update = (event: MediaQueryListEvent): void => {
    matches.value = event.matches
  }

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', update)
    onScopeDispose(() => mediaQuery.removeEventListener('change', update))
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(update)
    onScopeDispose(() => mediaQuery.removeListener?.(update))
  }

  return readonly(matches)
}

export function useIsMobile(): Readonly<Ref<boolean>> {
  return useBreakpoint('mobile')
}
