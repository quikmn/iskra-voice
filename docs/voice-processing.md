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
| **AI** (default) | DeepFilterNet3, a neural network, as WebAssembly in a Web Worker fed by an AudioWorklet at 48 kHz |
| **Strong** | RNNoise, as WebAssembly in an AudioWorklet at 48 kHz |
| **Standard** | The browser's own noise suppression |
| **Off** | Nothing |

- **Fallbacks.** AI needs AudioWorklet and WebAssembly with SIMD. If those are missing, the engine can't start, or it runs
  slower than real time for three seconds in a row (realtime factor above 0.6), or its worker is late for more than a
  quarter of each second three seconds in a row (a late frame now and then only costs a short crossfade), Iskra
  switches to RNNoise by itself and remembers it on that device. The developer console says why. Choosing AI again gives it another try. RNNoise falls back to the browser's suppression
  the same way. Settings always says which engine is active, why, and (in a call) how much CPU it takes.
- **AI noise removal strength** (Settings → Voice & audio, with AI on): **Gentle**, **Normal** (default) or **Max**:
  the most DeepFilterNet may turn anything down (18 dB, 30 dB, no limit). With a limit, what it takes out is mixed
  back in at that level, so noise stays far down and a wrong guess about the voice can only cost that much. Iskra
  runs DeepFilterNet with the local SNR thresholds its own command line tool uses (-15, 35, 35 dB: both stages on
  every frame); libDF's WebAssembly defaults (-10, 30, 20) skipped stages frame by frame and turned clean speech down
  by about 9 dB, choppily (see "How transparent it is" below). Changes apply right away, in a call too.
- **Automatic gain.** The browser's automatic gain control is off by default when Strong or AI runs (it pumps the
  level under the noise removal), and on with Standard or Off. Settings → Voice & audio lets you choose either way.
- **Voice activity.** With "Set automatically" on, Silero VAD (a small neural network, run in plain TypeScript in the
  same AudioWorklet) decides when you're speaking: the mic opens when it hears speech and stays open through pauses
  for 500 ms (hangover). It keeps the last 100 ms and sends them when it opens (pre-roll), so the start of a word
  isn't cut off. That makes you 100 ms late for as long as you keep talking; the gate never skips or squeezes audio
  to catch up (that sounds choppy and hurried). Silero notices a word 25–40 ms after its voiced part starts, so that
  always gets through; it notices the faintest lead-in (a breath or soft consonant 20–30 dB down) up to 145 ms
  after it starts, so that is now and then softened, by 15–30 ms typically and 45 ms at most on the test phrases
  (a longer pre-roll of 200 ms would keep all of it, at twice the delay). After a pause of
  more than the hangover it closes, and the next time starts over. Turn "Set automatically" off for a manual volume
  threshold instead. Push-to-talk is never gated or delayed. Your own speaking ring follows the same detector.
- **Off the audio thread.** The audio worklet only moves samples: it cuts the mic into 10 ms frames for a worker that
  runs DeepFilterNet, and plays what comes back at a fixed delay, the way DeepFilterNet's own LADSPA plugin uses a
  processing thread. Frames travel in eight slots allocated once and reused (nothing is allocated per frame on the
  audio thread): buffers transferred back and forth over a MessagePort, or shared memory with Atomics when the page
  is cross-origin isolated (none of the apps are today: the web app, the desktop app's `app://` and the phone apps
  all use the port; the choice is made at run time). If a frame isn't back in time, the worklet crossfades (2.7 ms)
  to the mic as it is, lined up to the same delay, and back once frames arrive again: never silence, never a skip
  or a repeat. A frame that couldn't be sent at all also takes the next three with it (the network's look-ahead
  still held audio from before the gap).
- **Latency added.** DeepFilterNet: 24 ms of framing and queue (one frame, plus one device buffer of headroom for the
  worker: the delay follows the device's buffer size, 24 ms for the usual 10 ms) plus the model's own look-ahead
  (30 ms), 54 ms in all; running inside the audio worklet it was 10.7 + 30 ms, with no room for a slow frame. RNNoise:
  about 10 ms. Voice activity: 100 ms while you talk ("Set automatically" only; none with a manual threshold or
  push-to-talk).
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
   for someone who just joined never stalls the rest of the call; it uses the same queue as the mic (24 ms on top of the
   model's look-ahead, crossfading to the voice as it is when the worker falls behind).
   It runs at the Normal strength.
   Clips record the cleaned voices while this is on.
2. **Even out voices** (on by default): a slow gain that brings each person towards the same loudness (only while they
   talk, at most ±12 dB, at most 3 dB per second, gliding sample by sample), then a gentle compressor (2:1 above
   -16 dBFS RMS, 10 ms attack, 200 ms release: only syllables well above the target) and a look-ahead limiter at
   -1 dBFS (it sees peaks 1.5 ms ahead and ramps down over that time, so it never clips or steps). Adds 1.5 ms.
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
- **Where the model comes from: your own server.** Whisper base (78 MB: encoder, decoder and vocabulary) is not part
  of the app and not in git. The first time captions turn on in a call, the app says "Captions need a one-time 78 MB
  download from this server" and waits for **Download**; progress shows with a **Cancel** button. The parts come from
  the Iskra server the call runs on (`GET /models/whisper-base-1846881b/<part>`, on the web, in the desktop app and
  in the phone apps alike). That server fetched the model once from Hugging Face, at the pinned commit, the first
  time anyone asked, and keeps it in its world folder (`models/`). So members' devices only ever talk to their own
  server; Hugging Face only sees the server's address, once. An owner can turn this off (`Captions.ModelDownload`
  in server.json, [hosting.md](hosting.md)); the app then says "This server doesn't offer captions".
- **Hash check, twice.** The server checks every file and part against the SHA-256s pinned in
  `client/src/state/captions/model.json` (compiled into both the server and the app) before keeping anything, and the
  app checks every part again before it's used or kept, and when it's read back. A part that doesn't match is
  refused ("wasn't the right file"); a failed download says so with **Try again**. Either way the call goes on
  untouched.
- **Kept on the device** in Cache Storage (`iskra-models`), or IndexedDB where Cache Storage can't keep it (the
  desktop app's `app://`), under a key that doesn't depend on the server: one download per device, whichever server
  it came from. Files from an older version are removed.
- **Privacy.** Getting the model is an ordinary file request to your own server. No audio, text or anything about
  the call goes with it, and the workers that run the models can't fetch anything at all.

## How transparent it is

`node scripts/audio-quality.mjs` in `client/` runs the e2e speech fixture (a real recording: a quiet room, noise
floor around -42 dBFS) through the same code the worklets run, block by block, and compares what comes out with what
went in (delay removed): clean, with fan and keyboard noise added (pink noise at -42 dBFS, clicks peaking at
-16 dBFS), and 20 dB quieter. `src/state/audio/quality.test.ts` holds the thresholds, plus a golden-file check
against DeepFilterNet's own command line tool (`deep-filter` 0.5.6: same output to within 16-bit rounding on clean
speech, within 0.5 dB of its quality on noisy speech) and three minutes through the simulated worklet (every sample
in order). Speech level is the median gain on speech, and its 5th percentile (the syllables turned down most);
gain motion is how much that gain changes from one 10 ms to the next.

| Input → stage | Before: SI-SDR / spectral distance dB | Before: speech level / dips dB | Before: gain motion RMS / max dB | After: SI-SDR / spectral distance dB | After: speech level / dips dB | After: gain motion RMS / max dB |
|---|---|---|---|---|---|---|
| Clean → AI noise removal | 3.2 / 5.8 | -9.5 / -4.0 | 2.47 / 9.9 | 20.6 / 5.0 | -0.5 / -1.3 | 0.31 / 2.1 |
| Noisy → AI noise removal | 6.1 / 9.6 | -0.8 / -11.2 | 2.53 / 9.7 | 19.7 / 9.0 | -0.6 / -1.2 | 0.39 / 2.5 |
| Clean → voice gate | -1.2 / 6.7 | 0.0 / -16.8 | 2.31 / 14.7 | > 99 / 0.2 | 0.0 / 0.0 | 0 / 0 |
| Clean → leveling | 10.4 / 2.3 | 1.4 / -4.3 | 0.59 / 4.1 | 12.7 / 1.7 | 4.2 / -3.7 | 0.23 / 1.5 |
| Clean → whole chain | -6.3 / 10.7 | -4.1 / -13.1 | 3.13 / 15.1 | 11.2 / 5.6 | 1.9 / -3.8 | 0.35 / 2.1 |
| Noisy → whole chain | -5.1 / 14.1 | -0.9 / -19.2 | 14.0 / > 99 | 11.5 / 9.3 | 1.7 / -4.1 | 0.41 / 2.4 |
| Quiet → whole chain | -5.9 / 13.2 | -5.7 / < -99 | 7.6 / > 99 | 7.9 / 8.3 | 4.0 / -7.0 | 0.51 / 3.0 |

- **Audio dropped while talking** (spread of the delay along the run): before 112 ms (clean) and 128 ms (noisy)
  through the gate; now 0. The gate's delay: before 250 ms, catching up by dropping audio; now 100 ms, steady.
- **Start of a word** (the fixture cut into 17 phrases, clean and noisy): the voiced start always gets through. The
  faint lead-in is softened by (median / p95) 27 / 45 ms clean and 15 / 45 ms noisy with the 100 ms pre-roll;
  measured alternatives: 60 ms 67 / 85, 80 ms 47 / 65, 120 ms 7 / 25, 200 ms none. No clipped samples anywhere, before or after; input volume 200% is limited instead of
  clipped. The gate opens once on the fixture and doesn't chatter, before and after.
- **Noise removed** (fan and keyboard, in the pauses, AI noise removal alone): 25 dB at Normal (30 dB limit), 17 dB
  at Gentle (18 dB), 32 dB at Max; before, everything (frames muted completely, speech too).
- The whole chain's SI-SDR is lower than its parts' because leveling changes the level slowly over the run (it
  should); the spectral distance and gain motion show what it does to the sound.
- What changed: DeepFilterNet's thresholds (the big one: clean speech was turned down by 9.5 dB, choppily, and some
  syllables muted), its strength limit, the gate (no more skipping), the leveler (RMS compressor, look-ahead limiter,
  gains that glide), and the gate's fade (it used to buzz faintly at half the sample rate while open).
- Not measured offline: Opus itself (48 kbps mono for voice, with FEC, RED and DTX) and the browser's own echo
  cancellation and automatic gain.

## CPU

Realtime factor = time spent / length of audio (0.05 = 5% of one CPU core). `node scripts/bench-audio.mjs` in
`client/` measures them on any machine. On a desktop PC (2026, x64, Node 24):

| | Realtime factor |
|---|---|
| DeepFilterNet3 (your mic, or one incoming voice) | ~0.07 (Chromium in the e2e tests: 0.05–0.12) |
| Silero VAD | ~0.025 |
| Leveling, per incoming voice | ~0.004 |
| Voice activity gate | < 0.001 |

What the audio thread pays (same script: time per 128-sample render call, which has 2.67 ms; the speech fixture
with noise):

| | Mean | p99 | Max |
|---|---|---|---|
| DeepFilterNet inside the render call (before) | 250 µs | 1.0–1.5 ms | 3.7–7.0 ms |
| DeepFilterNet in a worker, the worklet only queues (now) | 4 µs | 10 µs | 0.5–1.3 ms (first calls) |
| The worker, per 10 ms frame | 0.95–1.2 ms | 1.3–4.2 ms | 1.7–45 ms (the odd pause: garbage collection, the OS) |

In Chromium (the e2e tests) the worker takes 1.2–1.6 ms per frame on average and 2.0–2.6 ms at the slowest, with
no late frames, for your mic and incoming voices at once.

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
| [Whisper](https://github.com/openai/whisper) base (model), ONNX export by [onnx-community](https://huggingface.co/onnx-community/whisper-base) | commit `1846881b`; `encoder_model_quantized.onnx` (sha256 `58629933…`), `decoder_model_merged_quantized.onnx` (`fa3ef990…`), `vocab.json` (`50d6a919…`) | fetched once by each Iskra server into its `models/` folder, then by apps from there; not in git | MIT ([LICENSE](https://github.com/openai/whisper/blob/main/LICENSE)) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (runs Whisper) | 1.30.0, `ort-wasm-simd-threaded.wasm` (sha256 `3398c10d…`) | npm | MIT |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (runs the segmenter) | 0.10.35, `vision_wasm_module_internal.wasm` (sha256 `617b8e02…`) | npm | Apache-2.0 |
| [MediaPipe Selfie Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (model, general, float16) | version 1, `selfie_segmenter.tflite` (sha256 `191ac952…`) | `client/vendor/mediapipe/` | Apache-2.0 (`LICENSE`; per its model card) |

DeepFilterNet's code was changed to build against tract 0.23 (`client/vendor/deepfilternet/tract-0.23.patch`; API
updates only, the model is unchanged) and to let the app set its local SNR thresholds (`wasm-thresholds.patch`).
`scripts/build-deepfilter.sh` rebuilds `deepfilter.wasm` bit for bit from the pinned sources,
`client/vendor/deepfilternet/Cargo.lock` and Rust 1.99.0 (on any machine: local paths are mapped out of the binary);
the "DeepFilterNet build check" workflow does that whenever any of it changes and fails if the bytes differ. The
golden files in `client/vendor/deepfilternet/golden/` are the official `deep-filter` 0.5.6 tool's output for
`node scripts/deepfilter-golden.mjs` (see that script). Silero VAD's network is reimplemented in
`client/src/state/audio/silero.ts` and reads the official model file; its output matches ONNX Runtime to within 1e-6.

`node scripts/get-models.mjs` (from the repo root) fetches Whisper at the pinned commit, checks its SHA-256 and
writes the parts into `client/.models/` (ignored by git). The e2e test servers serve the model from there
(`Captions.ModelSource`) instead of fetching it from Hugging Face, and CI caches it. Without it, the Whisper unit test
and the captions e2e test are skipped. `--blur` also re-checks the committed Selfie Segmenter. The
background pictures are drawn in code; there are no image assets.
