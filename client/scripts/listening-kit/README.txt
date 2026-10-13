ISKRA LISTENING KIT ({{CREATED}})
==================================

Thanks for listening! This kit lets you judge Iskra's voice processing without a call. Every clip went through
exactly what a call does to a voice in the app, on a computer, with each noise suppression setting.

WHAT TO DO (about 30-45 minutes)
1. Open listening-test.html in Chrome, Edge or Firefox (double-click it; it works offline, nothing is sent anywhere).
   Use good headphones or monitors in a quiet room. Set a comfortable level once and leave it.
2. "Score" tab: for each clip there's the Original (what the microphone picked up) and six versions, A-F, shuffled
   per clip. All versions play in sync: press 0 for the original and 1-6 for A-F while it plays; switching is
   instant and keeps your place. Score each letter 1-5 on:
     Consonants    s, t, k, f, sh crisp and natural
     Word ends     endings kept, not swallowed or chopped
     Pacing        natural timing; nothing hurried, stretched or skipped
     Steady level  no pumping, dips or jumps in loudness
     Artefacts     5 = none; watery/metallic/robotic sound, gating, a breathing noise floor bring it down
   5 means "as good as the original" (for noisy clips: the voice as good as in the original, ideally with less
   noise). Notes are very welcome.
   Most important: the clean voices and how "AI, Normal" compares. Then AI Gentle vs AI Max.
3. "ABX" tab (optional, for differences you're unsure of): pick two settings, X is secretly one of them; 10 trials.
   Suggested: AI Normal vs Off, then AI Gentle vs AI Max.
4. "Send" tab: your name, what you listened on, overall thoughts, then "Save results file" (or "Copy results as
   text") and send it back. Your scores stay in the browser if you close the page.
5. Only afterwards: "Reveal" shows which letter was which, with the measurements (numbers.txt explains them).

LEVEL MATCHING
"Level-matched" (on by default) plays every version with its voice at the same loudness (-23 LUFS over the speech,
BS.1770), so louder doesn't sound better. Untick it to hear the levels as they come out of the chain.

THE CLIPS
Each voice is about 13 seconds: two sentences with a pause, so the voice gate opens twice.
{{INPUTS}}
Speech goes in at -26 dBFS active level with a quiet room under it (pink noise, -66 dBFS); noises are mixed at the
signal-to-noise ratio given (voice active level vs the noise's RMS).

THE SIX SETTINGS (Settings > Voice & audio > Noise suppression; everything else at the app's defaults)
{{CHAIN}}
In every case, in this order, as in a call:
- Chrome's own capture processing with the options Iskra asks for (its echo canceller is always on; it splits the
  signal into bands and puts it back together, which changes the waveform slightly in every setting alike).
- Iskra's noise suppression: RNNoise (Strong) or DeepFilterNet3 (AI) with its strength (Gentle 18 dB, Normal 30 dB,
  Max: no limit on how far it may turn things down).
- The mic's voice gate (Silero voice activity detection: opens when you speak, keeps 100 ms before that so word
  starts get through, stays open 500 ms through pauses), input volume and a limiter.
- Opus at 48 kbps as calls send it (Chrome's own encoder and decoder).
- The listener's "Even out voices": slow leveling towards -23 dB, a gentle 2:1 compressor and a -1 dBFS limiter.
Each clip was played twice in a row and only the second time kept, so everything had settled as it would mid-call.
Not included: network packet loss, and Opus' silence suppression (DTX: it drops packets of silence, which the
gate's pauses already are).

FILES
listening-test.html   the listening page (all the audio is inside it)
wav/                  every clip as a 48 kHz 16-bit WAV for your own tools; the file names say which setting it is,
                      so do the blind test in the page first
numbers.txt           the measurements

CREDITS (all test audio has a clear licence)
{{CREDITS}}
