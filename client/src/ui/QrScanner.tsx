// Scans a QR code with the camera. Uses the browser's BarcodeDetector where there is one (Chrome on
// Android, …); otherwise a ZXing WebAssembly build that ships with the app (Safari on iPhone, Firefox).
import { useEffect, useRef, useState } from 'react'
import { qrDetector, type Detector } from './qrDetector'

export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const done = useRef(onResult)
  useEffect(() => {
    done.current = onResult
  }, [onResult])

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser can't use the camera here. Paste the code instead.")
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      } catch {
        setProblem('No camera access. Allow the camera, or paste the code instead.')
        return
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop())
      const element = video.current!
      element.srcObject = stream
      await element.play().catch(() => undefined)
      let detector: Detector
      try {
        detector = await qrDetector()
      } catch {
        setProblem("Couldn't start the QR reader. Paste the code instead.")
        return
      }
      const tick = async () => {
        if (stopped) return
        try {
          if (element.readyState >= 2) {
            const found = (await detector.detect(element)).find((c) => c.rawValue)
            if (found && !stopped) {
              done.current(found.rawValue)
              return
            }
          }
        } catch {
          /* a frame that couldn't be read; try the next one */
        }
        timer = setTimeout(tick, 250)
      }
      void tick()
    }

    void start()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="qr-scanner">
      {problem ? <p className="muted">{problem}</p> : <video ref={video} playsInline muted aria-label="Camera view" />}
    </div>
  )
}
