// For the workers that run on-device models: they may only fetch from the app's own address (the model files), so
// no library they use can send anything anywhere, whatever it was built to do.
export function sameOriginOnly(): void {
  const scope = self as unknown as { fetch: typeof fetch; location: Location }
  const original = scope.fetch.bind(scope)
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), scope.location.href)
    if (url.origin !== scope.location.origin && url.protocol !== 'blob:' && url.protocol !== 'data:') {
      return Promise.reject(new TypeError(`blocked: ${url.origin} (on-device models stay on the device)`))
    }
    return original(input, init)
  }
}
