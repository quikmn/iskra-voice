# Voice processing

How Iskra cleans up your microphone and what you hear, blurs or replaces your camera's background, and captions what
people say. **Everything runs on your own device**: the models and engines ship inside the app (and the web app, from
its own address), audio and video are processed in your browser or desktop app, and no sound, picture, transcript or
model input is sent anywhere for processing. Nothing about it is logged or stored, apart from your settings on this
device, the flags that remember when this device was too slow for AI noise removal or a background effect, and the
speech model kept on the device so it's only downloaded once.

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

## Your camera's background

Settings → Camera: **Off** (default), **Blur**, or **Replace** with a built-in picture (Aurora, Sunset: soft gradients
drawn by the app, nothing to download) or a solid colour. The preview there runs exactly what calls run.

- **What runs.** MediaPipe's Selfie Segmenter (a 256×256 person-segmentation network, run by MediaPipe Tasks in
  WebAssembly on the CPU) finds you in each frame, in a Web Worker. The mask is smoothed over time (quick to follow
  real movement, slow to flicker) and feathered at the edges, then WebGL2 in the same worker draws you over a blurred
  copy of the frame (you are left out of the blur, so you don't bleed into it), the picture or the colour.
- **Off the main thread.** In Chrome, Edge and the desktop app the camera's frames stream into the worker and back
  out (insertable streams), so the page never touches them and a hidden tab keeps going. Other browsers send frames
  to the worker as images.
- **Nothing of the room first.** In a call the effect is in place before the camera is published, and until the first
  mask is ready the whole frame counts as background.
- **Fallback.** Needs WebAssembly and WebGL2 in workers. If the effect can't start, or the device can't keep up
  (fewer than 10 frames a second, or more than 60 ms a frame, for three 2-second windows in a row), it turns itself
  off with a notice in the call ("your real background is showing") and remembers that on this device until you
  choose an effect again. In a call, Settings shows the frame rate and time per frame; the app logs them to the
  developer console every 10 seconds.
- **Library telemetry.** Newer MediaPipe Tasks releases (1.x) send usage statistics to Google; Iskra uses 0.10.35,
  which has none, and the workers that run on-device models can only fetch from the app's own address anyway.

## Live captions

Opt in per listener: the captions button in the call, or Settings → Voice & audio → Captions ("Show captions in
calls"). Off by default. Each speaker's last words show under their name above the call controls (read out by screen
readers as a polite live region); the × or the button turns them off again.

- **What runs.** Each incoming voice (and yours, with "Caption my own voice too") is tapped in an AudioContext of its
  own (the cleaned-up voice when "Clean up others' audio" is on), resampled to 16 kHz in an AudioWorklet and sent to
  a captions Web Worker. There Silero VAD (the same model as for your mic) cuts it into phrases (200 ms pre-roll,
  ends after 500 ms of quiet, at most 8 s, at least 300 ms of speech), so only speech is ever transcribed. Whisper
  base (OpenAI's model, 8-bit ONNX export) transcribes one phrase at a time with ONNX Runtime Web (WebAssembly, one
  thread): greedy decoding, no timestamps, Whisper's own "no speech" and confidence checks, and a stop for runaway
  repeats. The feature extraction and decoding loop are Iskra's own TypeScript (`client/src/state/captions/`).
- **Languages.** English and Swedish. "Automatic" lets Whisper pick between the two for each phrase; or fix one.
  Whisper base is good in English and usable but rough in Swedish.
- **Why Whisper base.** It's MIT licensed (code and weights), speaks Swedish, and is the smallest Whisper that's
  worth reading (tiny is about twice as fast but much worse, in Swedish especially). Moonshine is faster on short
  phrases but English-only under a permissive license. Whisper always looks at 30 s of audio, so each phrase costs
  about the same no matter how short; WebGPU and multi-threading (which needs cross-origin isolation the app can't
  have) would make it much faster and are left for later.
- **Keeping up.** One phrase at a time; at most 4 waiting and 3 people at once; a phrase that waited more than 8 s is
  skipped. Skipping 3 within 20 s, or one phrase taking more than 7 s, pauses captions for 20 s with "Captions paused:
  this device is too slow right now" and then tries again.
- **Privacy.** The text exists only in this page's memory: it's shown, kept for 8 seconds after the last words, and
  dropped. It is never sent to the server or to anyone, never stored, never logged, and not part of clips.
- **Where the model comes from.** Whisper base (78 MB: encoder, decoder and vocabulary) is not part of the app and
  not in git. The first time captions turn on in a call, the app says "Captions need a one-time 92 MB download"
  (78 MB in the desktop and phone apps, which already have ONNX Runtime's 14 MB) and waits for **Download**; progress
  shows with a **Cancel** button. The web app downloads it from its own address (`/models/whisper-base-1846881b/`);
  the desktop app (`app://`) and the phone apps (`capacitor://`, `http://localhost`) from `https://app.iskra.foo`,
  where the web deploy publishes it (`deploy.yml`, CORS open for those pages). The files are parts of at most 20 MiB,
  so Cloudflare Pages serves them.
- **Hash check.** Every part is checked against the SHA-256 compiled into the app
  (`client/src/state/captions/model.json`) before it's used or kept, and again when read back. A part that doesn't
  match is refused ("wasn't the right file"); a failed download (offline, app.iskra.foo down) says so with **Try
  again**. Either way the call itself goes on untouched.
- **Kept on the device** in Cache Storage (`iskra-models`), or IndexedDB where Cache Storage can't keep it (the
  desktop app's `app://`), so it's never downloaded again; files from an older version are removed.
- **What the download tells anyone.** Only that this address fetched the model: Cloudflare (which hosts
  app.iskra.foo) sees an ordinary file request. No audio, text or anything about the call goes with it, and the
  workers that run the models can't fetch anything at all from elsewhere.

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

Live captions (`node scripts/bench-captions.mjs [file.wav]`, same machine): Whisper base takes about 2.0 s of encoder
plus 30–50 ms per word, so **2.3–2.9 s per phrase** whatever its length (Chromium: 2.4–2.7 s encoder); for the 8 s
test phrase that's a realtime factor of 0.35, for a 1–3 s phrase 1 or more. In other words: captions arrive 2–3 s
after someone finishes a phrase, and one desktop core keeps up with roughly one person talking continuously; with
more, phrases get skipped. Loading the model takes about 0.6 s (Node) to 1.5 s (Chromium, from the cache).

Background effects (Chromium in the e2e tests, 640×480 fake camera at 20 fps, software WebGL): 8–15 ms per frame
alone (segmentation about 10 ms, drawing 2–3 ms: roughly a third of a core at 30 fps), 25 ms per frame and 16 fps
while a whole call, AI noise removal and captions run on the same machine. A real GPU makes the drawing faster;
phones are slower, which is what the fallback is for.

## Third-party notices

| Component | Version | Where | License |
|---|---|---|---|
| [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (libDF and the DeepFilterNet3 model) | commit `d375b2d8`, model `DeepFilterNet3_onnx.tar.gz`, stored as `.tar.gz.bin` (sha256 `c94d91f7…`) | `client/vendor/deepfilternet/` | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |
| [tract](https://github.com/sonos/tract) (runs the DeepFilterNet model) | 0.23.3 | compiled into `deepfilter.wasm` | MIT OR Apache-2.0 |
| [Silero VAD](https://github.com/snakers4/silero-vad) (model) | v6, `silero_vad_16k_op15.onnx` (sha256 `7ed98ddb…`) | `client/vendor/silero-vad/` | MIT (`LICENSE`) |
| [RNNoise](https://github.com/xiph/rnnoise) via [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) | 0.4.1 | npm | BSD-3-Clause / MIT |
| [Whisper](https://github.com/openai/whisper) base (model), ONNX export by [onnx-community](https://huggingface.co/onnx-community/whisper-base) | commit `1846881b`; `encoder_model_quantized.onnx` (sha256 `58629933…`), `decoder_model_merged_quantized.onnx` (`fa3ef990…`), `vocab.json` (`50d6a919…`) | downloaded on first use (`/models/` on app.iskra.foo), not in git | MIT ([LICENSE](https://github.com/openai/whisper/blob/main/LICENSE)) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (runs Whisper) | 1.30.0, `ort-wasm-simd-threaded.wasm` (sha256 `3398c10d…`) | npm | MIT |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (runs the segmenter) | 0.10.35, `vision_wasm_module_internal.wasm` (sha256 `617b8e02…`) | npm | Apache-2.0 |
| [MediaPipe Selfie Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (model, general, float16) | version 1, `selfie_segmenter.tflite` (sha256 `191ac952…`) | `client/vendor/mediapipe/` | Apache-2.0 (`LICENSE`; per its model card) |

DeepFilterNet's code was changed to build against tract 0.23 (`client/vendor/deepfilternet/tract-0.23.patch`; API
updates only, the model is unchanged). `scripts/build-deepfilter.sh` rebuilds `deepfilter.wasm` bit for bit from the
pinned sources and `client/vendor/deepfilternet/Cargo.lock`. Silero VAD's network is reimplemented in
`client/src/state/audio/silero.ts` and reads the official model file; its output matches ONNX Runtime to within 1e-6.

`node scripts/get-models.mjs` (from the repo root) fetches Whisper at the pinned commit, checks its SHA-256 and
writes the parts the app asks for into `client/.models/` (ignored by git), which the Vite dev and preview servers serve
at `/models/`; CI caches it for the e2e tests, and the web deploy copies it into the build. Without it, the Whisper
unit test and the captions e2e test are skipped. `--blur` also re-checks the committed Selfie Segmenter. The
background pictures are drawn in code; there are no image assets.
