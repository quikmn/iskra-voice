# Voice processing

How Iskra cleans up your microphone and what you hear. **Everything runs on your own device**: the models and engines
ship inside the app (and the web app, from its own address), audio is processed in your browser or desktop app, and no
sound, transcript or model input is sent anywhere for processing. Nothing about it is logged or stored, apart from your
settings on this device and one flag that remembers when this device was too slow for AI noise removal.

## Your microphone

| Setting (Settings → Voice & audio → Noise suppression) | What runs |
|---|---|
| **AI** (default) | DeepFilterNet3, a neural network, as WebAssembly in an AudioWorklet at 48 kHz |
| **Strong** | RNNoise, as WebAssembly in an AudioWorklet at 48 kHz |
| **Standard** | The browser's own noise suppression |
| **Off** | Nothing |

- **Fallbacks.** AI needs AudioWorklet and WebAssembly with SIMD. If those are missing, the engine can't start, or it runs
  slower than real time for three seconds in a row (realtime factor above 0.6), Iskra switches to RNNoise by itself and
  remembers it on that device. Choosing AI again gives it another try. RNNoise falls back to the browser's suppression
  the same way. Settings always says which engine is active, why, and (in a call) how much CPU it takes.
- **Voice activity.** With "Set automatically" on, Silero VAD (a small neural network, run in plain TypeScript in the
  same AudioWorklet) decides when you're speaking: the mic opens when it hears speech and stays open through pauses
  for 500 ms (hangover). It keeps the last 250 ms and sends them when it opens (pre-roll), so the first syllable isn't
  cut off; that makes you about 250 ms late for a moment, and the gate catches up by skipping the quiet gaps between
  words. Turn "Set automatically" off for a manual volume threshold instead. Push-to-talk is never gated or delayed.
  Your own speaking ring follows the same detector.
- **Latency added.** DeepFilterNet: about 10 ms of framing plus the model's own look-ahead (about 30 ms). RNNoise:
  about 10 ms. Voice activity: none while you talk normally, up to 250 ms right after you start talking (see above).
- **Hi-fi.** In voice channels where an admin allowed it, turning on "Hi-fi audio" sends your mic in stereo at
  128 kbps with no noise suppression, echo cancellation or automatic gain. Use headphones.
- **Resilience.** The mic is published with Opus in-band FEC, RED (redundant audio: each packet also carries the
  previous ones, so a lost packet costs nothing) and DTX (next to nothing is sent while you're quiet). LiveKit's
  default codecs include `audio/red`, so every room negotiates it.

## What you hear

Where the app mixes call audio with Web Audio (Chrome, Edge, the desktop app; not Safari or Firefox), each incoming voice
goes through:

1. **Clean up others' audio** (off by default): DeepFilterNet3 when you use AI noise removal and up to four people
   are talking, RNNoise otherwise or when the device can't keep up. DeepFilterNet runs in a Web Worker, so starting it
   for someone who just joined never stalls the rest of the call; it adds about 20 ms on top of the model's look-ahead.
   Clips record the cleaned voices while this is on.
2. **Even out voices** (on by default): a slow gain that brings each person towards the same loudness (only while they
   talk, at most ±12 dB, at most 3 dB per second), then a compressor and a limiter.
3. Your per-person volume, on top.

## CPU

Realtime factor = time spent / length of audio (0.05 = 5% of one CPU core). `node scripts/bench-audio.mjs` in
`client/` measures them on any machine. On a desktop PC (2026, x64, Node 24):

| | Realtime factor |
|---|---|
| DeepFilterNet3 (your mic, or one incoming voice) | ~0.05 (Chromium in the e2e tests: 0.05–0.12) |
| Silero VAD | ~0.025 |
| Leveling, per incoming voice | ~0.002 |
| Voice activity gate | < 0.001 |

DeepFilterNet's start-up takes about half a second (model loading); the first use downloads about 12 MB (16 MB
WebAssembly and an 8 MB model, compressed). Phones are several times slower, which is what the automatic fallback is
for. The app logs the realtime factor to the developer console every 10 seconds while AI noise removal runs.

## Third-party notices

| Component | Version | Where | License |
|---|---|---|---|
| [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (libDF and the DeepFilterNet3 model) | commit `d375b2d8`, model `DeepFilterNet3_onnx.tar.gz`, stored as `.tar.gz.bin` (sha256 `c94d91f7…`) | `client/vendor/deepfilternet/` | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |
| [tract](https://github.com/sonos/tract) (runs the DeepFilterNet model) | 0.23.3 | compiled into `deepfilter.wasm` | MIT OR Apache-2.0 |
| [Silero VAD](https://github.com/snakers4/silero-vad) (model) | v6, `silero_vad_16k_op15.onnx` (sha256 `7ed98ddb…`) | `client/vendor/silero-vad/` | MIT (`LICENSE`) |
| [RNNoise](https://github.com/xiph/rnnoise) via [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) | 0.4.1 | npm | BSD-3-Clause / MIT |

DeepFilterNet's code was changed to build against tract 0.23 (`client/vendor/deepfilternet/tract-0.23.patch`; API
updates only, the model is unchanged). `scripts/build-deepfilter.sh` rebuilds `deepfilter.wasm` bit for bit from the
pinned sources and `client/vendor/deepfilternet/Cargo.lock`. Silero VAD's network is reimplemented in
`client/src/state/audio/silero.ts` and reads the official model file; its output matches ONNX Runtime to within 1e-6.
