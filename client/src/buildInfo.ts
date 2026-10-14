// Which build this is: the release version and the commit it was built from (vite.config.ts injects __ISKRA_COMMIT__).
import { SHORT_SHA } from './commit'
import { RELEASE_VERSION } from './links'

declare const __ISKRA_COMMIT__: string | undefined

export const BUILD_COMMIT: string = typeof __ISKRA_COMMIT__ === 'string' && SHORT_SHA.test(__ISKRA_COMMIT__) ? __ISKRA_COMMIT__ : 'dev'

/** "2.0.0-alpha.14 · a89a580", the same as in the desktop window title. */
export function buildLabel(version = RELEASE_VERSION, commit = BUILD_COMMIT): string {
  return `${version} · ${commit}`
}
