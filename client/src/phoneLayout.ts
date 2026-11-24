// When the app uses its phone layout (drawers, sheets, full-screen panels): one definition for the stylesheets and
// the code. Plain strings only: vite.config.ts imports this file too.
//
// A phone is a narrow window, or a short touch screen that is not wide either: a phone held sideways (844 x 390,
// 932 x 430). A tablet on its side (1180 x 820) and a desktop window of any size keep the wide layout.
//
// In a stylesheet write `@media (--phone)`, `@media (--wide)` and `@media (--phone-sideways)`; the build puts the queries below in their place
// (vite.config.ts). Never write `(max-width: 760px)` for "phone" by hand: it misses the sideways phone.

/** The alternatives of "phone layout"; any one is enough. */
export const PHONE_LAYOUT_QUERIES = ['(max-width: 760px)', '(pointer: coarse) and (max-height: 500px) and (max-width: 1000px)'] as const

/** The alternatives of "wide layout": exactly when no phone alternative holds. */
export const WIDE_LAYOUT_QUERIES = [
  '(min-width: 760.01px) and (min-height: 500.01px)',
  '(min-width: 1000.01px)',
  '(min-width: 760.01px) and (pointer: fine)',
  '(min-width: 760.01px) and (pointer: none)',
] as const

/**
 * A phone held sideways, for the few things that differ from an upright phone (a call takes the whole screen). Wider
 * than any upright phone, so an upright phone with its keyboard open (360 x 330) doesn't count.
 */
export const PHONE_SIDEWAYS = '(pointer: coarse) and (max-height: 500px) and (min-width: 560px) and (max-width: 1000px)'

/** For `matchMedia`. */
export const PHONE_LAYOUT = PHONE_LAYOUT_QUERIES.join(', ')

/** The names stylesheets use, and what each stands for. */
export const LAYOUT_MEDIA: Record<string, readonly string[]> = {
  '(--phone-sideways)': [PHONE_SIDEWAYS],
  '(--phone)': PHONE_LAYOUT_QUERIES,
  '(--wide)': WIDE_LAYOUT_QUERIES,
}

/**
 * A media query list with the names replaced. A name may stand alone or be joined to other conditions with `and`
 * ("(--phone) and (orientation: landscape)"): each alternative gets those conditions.
 */
export function expandLayoutMedia(params: string): string {
  return params.split(',').flatMap((part) => {
    const name = Object.keys(LAYOUT_MEDIA).find((n) => part.includes(n))
    return name ? LAYOUT_MEDIA[name].map((query) => part.replace(name, query).trim()) : [part.trim()]
  }).join(', ')
}
