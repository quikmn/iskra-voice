import { describe, expect, it } from 'vitest'
import clientPackage from '../../package.json'
import ponyfillPackage from '../../node_modules/barcode-detector/package.json'
import zxingPackage from '../../node_modules/zxing-wasm/package.json'

// qrDetector loads our own zxing-wasm .wasm into barcode-detector's glue: the two must be the same build. A
// zxing-wasm bump on its own (3.1.5 next to barcode-detector 3.2.2) broke the QR reader only in e2e/link.spec.ts.
describe('QR reader packages', () => {
  it('zxing-wasm is exactly the version barcode-detector was built against', () => {
    const wanted = (ponyfillPackage as { dependencies: Record<string, string> }).dependencies['zxing-wasm']
    expect(clientPackage.dependencies['zxing-wasm']).toBe(wanted)
    expect(zxingPackage.version).toBe(wanted)
  })
})
