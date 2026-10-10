// Finds a QR code decoder: the browser's BarcodeDetector where there is one (Chrome on Android, …);
// otherwise a ZXing WebAssembly build that ships with the app (Safari on iPhone, Firefox).
export interface Detector {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<{ rawValue: string }[]>
}

export async function qrDetector(preferNative = true): Promise<Detector> {
  const Native = preferNative && (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) return new Native({ formats: ['qr_code'] })
    } catch {
      /* fall through to the bundled decoder */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  // Load the decoder from our own files, never a CDN.
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })
  return new BarcodeDetector({ formats: ['qr_code'] })
}
