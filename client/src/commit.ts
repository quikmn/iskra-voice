// The short commit a build is made from. vite.config.ts uses this at build time; buildInfo.ts reads the result.

export const SHORT_SHA = /^[0-9a-f]{7}$/

/** 7 hex characters from CI's GITHUB_SHA, Cloudflare's CF_PAGES_COMMIT_SHA or `git rev-parse HEAD`; "dev" without any. */
export function shortCommit(env: Record<string, string | undefined>, gitHead: () => string | null): string {
  const short = (sha: string | null | undefined) => {
    const s = sha?.trim().toLowerCase().slice(0, 7)
    return s && SHORT_SHA.test(s) ? s : null
  }
  return short(env.GITHUB_SHA) ?? short(env.CF_PAGES_COMMIT_SHA) ?? short(gitHead()) ?? 'dev'
}
