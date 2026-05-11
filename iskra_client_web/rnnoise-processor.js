'use strict';

// AudioWorklet processor for RNNoise WASM noise suppression.
// Accepts { type: 'init', wasmBytes: ArrayBuffer } and { type: 'enable', value: bool }
// via port. Posts { type: 'ready' } or { type: 'error', message } back.

const FRAME = 480; // RNNoise expects exactly 480 samples per call (10 ms @ 48 kHz)
const CAP   = FRAME * 2; // circular queue capacity

class RnnoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._ready   = false;
        this._enabled = true;
        this._wasm    = null;
        this._state   = 0;
        this._inPtr   = 0;
        this._outPtr  = 0;
        this._heapF32 = null;
        this._heapBuf = null;

        // Circular input queue
        this._iq  = new Float32Array(CAP);
        this._iqW = 0;
        this._iqR = 0;
        this._iqN = 0;

        // Circular output queue — pre-filled with FRAME zeros so the input
        // accumulator has time to fill before the first drain (eliminates underruns).
        this._oq  = new Float32Array(CAP);
        this._oqW = FRAME; // write pointer starts after the pre-filled zeros
        this._oqR = 0;
        this._oqN = FRAME;

        this.port.onmessage = (e) => {
            if (e.data.type === 'init')   this._initWasm(e.data.wasmBytes);
            if (e.data.type === 'enable') this._enabled = !!e.data.value;
        };
    }

    async _initWasm(bytes) {
        try {
            let mem = null;

            const { instance } = await WebAssembly.instantiate(bytes, {
                a: {
                    // _emscripten_resize_heap(requestedSize) — grow memory, return new size
                    a(reqSize) {
                        if (!mem) return 0;
                        try {
                            const grow = reqSize - mem.buffer.byteLength;
                            if (grow > 0) mem.grow(Math.ceil(grow / 65536));
                            return mem.buffer.byteLength;
                        } catch { return 0; }
                    },
                    // _emscripten_memcpy_big(dst, src, n)
                    b(dst, src, n) {
                        new Uint8Array(mem.buffer).copyWithin(dst, src, src + n);
                    }
                }
            });

            const exp = instance.exports;
            mem = exp.c;    // WebAssembly.Memory — must be set before calling exports

            exp.d();        // __wasm_call_ctors — initialise global C state

            this._state  = exp.f(0);          // rnnoise_create(model=NULL)
            this._inPtr  = exp.g(FRAME * 4);  // malloc(480 * sizeof(float))
            this._outPtr = exp.g(FRAME * 4);
            this._wasm   = exp;
            this._ready  = true;

            this.port.postMessage({ type: 'ready' });
        } catch (err) {
            this.port.postMessage({ type: 'error', message: String(err.message || err) });
        }
    }

    _getHeap() {
        // Re-create Float32Array view only when the backing buffer changes (memory growth).
        const buf = this._wasm.c.buffer;
        if (buf !== this._heapBuf) {
            this._heapBuf = buf;
            this._heapF32 = new Float32Array(buf);
        }
        return this._heapF32;
    }

    _runFrame() {
        const heap = this._getHeap();
        const iw   = this._inPtr  >> 2;
        const ow   = this._outPtr >> 2;
        const iq   = this._iq;

        // Copy FRAME samples from input queue → WASM heap (scaled to int16 range)
        for (let i = 0; i < FRAME; i++) {
            heap[iw + i] = iq[this._iqR] * 32768;
            this._iqR = (this._iqR + 1) % CAP;
        }
        this._iqN -= FRAME;

        // Run RNNoise (VAD probability return value is discarded)
        this._wasm.j(this._state, this._outPtr, this._inPtr);

        // Copy WASM output → output queue (scaled back to float)
        const oq = this._oq;
        for (let i = 0; i < FRAME; i++) {
            oq[this._oqW] = heap[ow + i] / 32768;
            this._oqW = (this._oqW + 1) % CAP;
        }
        this._oqN += FRAME;
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!out) return true;

        const n = out.length; // always 128

        if (!this._ready || !this._enabled || !inp) {
            if (inp) out.set(inp); // passthrough
            return true;
        }

        // Enqueue all input samples
        const iq = this._iq;
        for (let i = 0; i < n; i++) {
            if (this._iqN < CAP) {
                iq[this._iqW] = inp[i];
                this._iqW = (this._iqW + 1) % CAP;
                this._iqN++;
            }
        }

        // Process as many complete frames as available
        while (this._iqN >= FRAME) this._runFrame();

        // Drain output queue into the output block
        const oq = this._oq;
        for (let i = 0; i < n; i++) {
            if (this._oqN > 0) {
                out[i] = oq[this._oqR];
                this._oqR = (this._oqR + 1) % CAP;
                this._oqN--;
            } else {
                out[i] = 0; // transient underrun during startup — rare
            }
        }

        return true;
    }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
