// Camera background effects, off the main thread. Each frame: MediaPipe's Selfie Segmenter (WebAssembly) finds the
// person, the mask is smoothed over time, and WebGL draws the frame over a blurred copy of itself (the person is left
// out of the blur, so they don't bleed into it), a built-in picture or a solid colour, with soft edges. Nothing
// leaves the device.
// Frames arrive one of two ways: where the browser has insertable streams (Chrome, Edge, the desktop app) the camera's
// frames stream straight in and the results stream straight out, so the page's own thread never touches them and a
// hidden tab keeps going; elsewhere the page sends ImageBitmaps and gets ImageBitmaps back.
import { ImageSegmenter } from '@mediapipe/tasks-vision'
import { colorFloats, smoothMask, type Backdrop, type BackgroundMode } from './effects'
import { sameOriginOnly } from '../localOnly'

sameOriginOnly()

interface Look {
  mode: BackgroundMode
  backdrop: Backdrop
  color: string
}

type Incoming =
  | { type: 'init'; loader: string; wasm: string; model: string; look: Look }
  | { type: 'look'; look: Look }
  | { type: 'frame'; bitmap: ImageBitmap }
  | { type: 'streams'; readable: ReadableStream<VideoFrame>; writable?: WritableStream<VideoFrame> }
  | { type: 'close' }

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

let segmenter: ImageSegmenter | null = null
let look: Look = { mode: 'blur', backdrop: 'aurora', color: '#2f3640' }
let mask: Float32Array | null = null
let renderer: Renderer | null = null
let lastTimestamp = 0
// Measured over two-second windows and reported to the page.
let processed = 0
let spentMs = 0
let windowStart = performance.now()

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const m = e.data
  if (m.type === 'init') {
    look = m.look
    try {
      segmenter = await createSegmenter(m)
      renderer = new Renderer()
      renderer.setLook(look)
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) })
    }
  } else if (m.type === 'look') {
    look = m.look
    renderer?.setLook(look)
  } else if (m.type === 'frame') {
    try {
      await processFrame(m.bitmap, m.bitmap.width, m.bitmap.height)
      const out = renderer!.canvas.transferToImageBitmap()
      post({ type: 'frame', bitmap: out }, [out])
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) })
    } finally {
      m.bitmap.close()
    }
  } else if (m.type === 'streams') {
    void pump(m.readable, m.writable)
  } else if (m.type === 'close') {
    segmenter?.close()
    segmenter = null
    self.close()
  }
}

/** Segments and draws one frame into the renderer's canvas. */
async function processFrame(frame: ImageBitmap | VideoFrame, width: number, height: number): Promise<void> {
  if (!segmenter || !renderer) throw new Error('not ready')
  const started = performance.now()
  // The model looks at 256×256 anyway: scaling down first (on the GPU) saves MediaPipe reading the whole frame.
  const small = await createImageBitmap(frame, { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'low' })
  // MediaPipe wants strictly increasing timestamps.
  lastTimestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()))
  segmenter.segmentForVideo(small, lastTimestamp, (result) => {
    const confidence = result.confidenceMasks?.[0]
    if (!confidence) return
    const next = confidence.getAsFloat32Array()
    if (!mask || mask.length !== next.length) mask = next.slice()
    else smoothMask(mask, next)
    renderer!.setMask(mask, confidence.width, confidence.height)
  })
  small.close()
  renderer.draw(frame, width, height)
  processed++
  spentMs += performance.now() - started
  const now = performance.now()
  if (now - windowStart >= 2000) {
    post({ type: 'stats', fps: (processed * 1000) / (now - windowStart), frameMs: processed ? spentMs / processed : 0 })
    processed = 0
    spentMs = 0
    windowStart = now
  }
}

let pumping = 0
/** Insertable streams: camera frames in, processed frames out, until the camera stops or a new one comes. */
async function pump(readable: ReadableStream<VideoFrame>, writable?: WritableStream<VideoFrame>): Promise<void> {
  const mine = ++pumping
  const reader = readable.getReader()
  const writer = writable?.getWriter() ?? output
  if (writable) output = writer
  try {
    for (;;) {
      const { done, value: frame } = await reader.read()
      if (done || mine !== pumping) {
        frame?.close()
        break
      }
      let out: VideoFrame | null = null
      try {
        await processFrame(frame, frame.displayWidth, frame.displayHeight)
        out = new VideoFrame(renderer!.canvas, { timestamp: frame.timestamp ?? 0 })
      } catch (err) {
        post({ type: 'error', message: (err as Error)?.message ?? String(err) })
      } finally {
        frame.close()
      }
      // The track was stopped (camera off, effect off): nothing more to send.
      if (out && !(await writer!.write(out).then(() => true, () => (out!.close(), false)))) break
    }
  } finally {
    reader.releaseLock()
    void readable.cancel().catch(() => undefined)
  }
}
let output: WritableStreamDefaultWriter<VideoFrame> | null = null

async function createSegmenter(m: { loader: string; wasm: string; model: string }): Promise<ImageSegmenter> {
  // The CPU path (XNNPACK, WebAssembly SIMD): about 18 ms a frame on a desktop, and the same everywhere. The GPU
  // path was slower where it could be measured (it waits to read the mask back) and isn't in every worker.
  return ImageSegmenter.createFromOptions({ wasmLoaderPath: m.loader, wasmBinaryPath: m.wasm }, {
    runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false, baseOptions: { modelAssetPath: m.model, delegate: 'CPU' },
  })
}

// ── Drawing ──────────────────────────────────────────────────────────────

const VERTEX = `#version 300 es
in vec2 position;
out vec2 glUv;
out vec2 imageUv;
void main() {
  glUv = position * 0.5 + 0.5;
  imageUv = vec2(glUv.x, 1.0 - glUv.y);
  gl_Position = vec4(position, 0.0, 1.0);
}`

// Shared: the person mask with soft edges (a little blur across the edge, then a smooth step).
const MASK = `
uniform sampler2D mask;
uniform vec2 maskTexel;
float person(vec2 uv) {
  float m = texture(mask, uv).r * 0.4;
  m += texture(mask, uv + vec2(maskTexel.x, 0.0) * 1.5).r * 0.15;
  m += texture(mask, uv - vec2(maskTexel.x, 0.0) * 1.5).r * 0.15;
  m += texture(mask, uv + vec2(0.0, maskTexel.y) * 1.5).r * 0.15;
  m += texture(mask, uv - vec2(0.0, maskTexel.y) * 1.5).r * 0.15;
  return smoothstep(0.3, 0.75, m);
}`

// The frame with the person taken out (premultiplied by "not person"), at a quarter of the size.
const PREP = `#version 300 es
precision mediump float;
in vec2 glUv;
in vec2 imageUv;
uniform sampler2D frame;
${MASK}
out vec4 color;
void main() {
  float bg = 1.0 - person(imageUv);
  color = vec4(texture(frame, imageUv).rgb * bg, bg);
}`

// One direction of a 9-tap Gaussian blur.
const BLUR = `#version 300 es
precision mediump float;
in vec2 glUv;
uniform sampler2D source;
uniform vec2 step;
out vec4 color;
void main() {
  color = texture(source, glUv) * 0.2270270270;
  color += texture(source, glUv + step * 1.3846153846) * 0.3162162162;
  color += texture(source, glUv - step * 1.3846153846) * 0.3162162162;
  color += texture(source, glUv + step * 3.2307692308) * 0.0702702703;
  color += texture(source, glUv - step * 3.2307692308) * 0.0702702703;
}`

const COMPOSE = `#version 300 es
precision mediump float;
in vec2 glUv;
in vec2 imageUv;
uniform sampler2D frame;
uniform sampler2D blurred;
uniform sampler2D picture;
uniform int mode; // 0 blur, 1 picture, 2 colour
uniform vec3 solid;
uniform vec2 pictureScale;
${MASK}
out vec4 color;
void main() {
  vec3 me = texture(frame, imageUv).rgb;
  vec3 bg;
  if (mode == 0) {
    vec4 b = texture(blurred, glUv);
    bg = b.a > 0.02 ? b.rgb / b.a : me;
  } else if (mode == 1) {
    bg = texture(picture, (imageUv - 0.5) * pictureScale + 0.5).rgb;
  } else {
    bg = solid;
  }
  color = vec4(mix(bg, me, person(imageUv)), 1.0);
}`

interface Target {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
}

class Renderer {
  readonly canvas = new OffscreenCanvas(2, 2)
  private readonly gl: WebGL2RenderingContext
  private readonly prep: WebGLProgram
  private readonly blur: WebGLProgram
  private readonly compose: WebGLProgram
  private readonly frameTex: WebGLTexture
  private readonly maskTex: WebGLTexture
  private readonly pictureTex: WebGLTexture
  private targets: [Target, Target] | null = null
  private maskSize = [1, 1]
  private maskBytes: Uint8Array | null = null
  private look: Look | null = null
  private picture: Backdrop | null = null

  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) throw new Error('no WebGL2 in workers here')
    this.gl = gl
    this.prep = this.program(PREP)
    this.blur = this.program(BLUR)
    this.compose = this.program(COMPOSE)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.frameTex = this.texture()
    this.maskTex = this.texture()
    this.pictureTex = this.texture()
    // Until the first mask: all background (the whole frame blurred or replaced: nothing of the room shows).
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]))
  }

  setLook(look: Look): void {
    this.look = look
    if (look.mode === 'replace' && look.backdrop !== 'color' && this.picture !== look.backdrop) {
      this.picture = look.backdrop
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D, this.pictureTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawBackdrop(look.backdrop))
    }
  }

  setMask(mask: Float32Array, width: number, height: number): void {
    const gl = this.gl
    if (!this.maskBytes || this.maskBytes.length !== mask.length) this.maskBytes = new Uint8Array(mask.length)
    for (let i = 0; i < mask.length; i++) this.maskBytes[i] = mask[i] * 255
    this.maskSize = [width, height]
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, this.maskBytes)
  }

  draw(frame: ImageBitmap | VideoFrame, width: number, height: number): void {
    const gl = this.gl
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      this.targets = null
    }
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    const look = this.look!
    const mode = look.mode === 'blur' ? 0 : look.backdrop === 'color' ? 2 : 1
    const maskTexel = [1 / this.maskSize[0], 1 / this.maskSize[1]]

    if (mode === 0) {
      const [a, b] = this.blurTargets(width, height)
      // Person out, quarter size; then blur twice in each direction (wide and smooth).
      this.pass(this.prep, a, { frame: this.frameTex, mask: this.maskTex }, { maskTexel })
      for (let i = 0; i < 2; i++) {
        this.pass(this.blur, b, { source: a.texture }, { step: [1 / a.width, 0] })
        this.pass(this.blur, a, { source: b.texture }, { step: [0, 1 / a.height] })
      }
    }
    const pictureScale = [1, 1]
    // Cover the frame with the 16:9 picture, cropping what doesn't fit.
    const aspect = width / height
    if (aspect > 16 / 9) pictureScale[1] = (16 / 9) / aspect
    else pictureScale[0] = aspect / (16 / 9)
    this.pass(this.compose, null, { frame: this.frameTex, mask: this.maskTex, blurred: this.targets?.[0].texture ?? this.frameTex, picture: this.pictureTex }, {
      maskTexel, mode, solid: colorFloats(look.color), pictureScale,
    })
  }

  private blurTargets(width: number, height: number): [Target, Target] {
    if (this.targets) return this.targets
    const w = Math.max(1, Math.round(width / 4))
    const h = Math.max(1, Math.round(height / 4))
    this.targets = [this.target(w, h), this.target(w, h)]
    return this.targets
  }

  private target(width: number, height: number): Target {
    const gl = this.gl
    const texture = this.texture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, fbo, width, height }
  }

  private pass(program: WebGLProgram, target: Target | null, textures: Record<string, WebGLTexture>, uniforms: Record<string, number | number[]>): void {
    const gl = this.gl
    gl.useProgram(program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null)
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height)
    let unit = 0
    for (const [name, texture] of Object.entries(textures)) {
      const location = gl.getUniformLocation(program, name)
      if (!location) continue
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(location, unit++)
    }
    for (const [name, value] of Object.entries(uniforms)) {
      const location = gl.getUniformLocation(program, name)
      if (!location) continue
      if (name === 'mode') gl.uniform1i(location, value as number)
      else if (Array.isArray(value) && value.length === 2) gl.uniform2f(location, value[0], value[1])
      else if (Array.isArray(value) && value.length === 3) gl.uniform3f(location, value[0], value[1], value[2])
      else gl.uniform1f(location, value as number)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private texture(): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  private program(fragment: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program')
    return program
  }
}

/** The built-in pictures, drawn here (soft gradients: nothing to download, nothing to license). */
function drawBackdrop(kind: Exclude<Backdrop, 'color'>): OffscreenCanvas {
  const canvas = new OffscreenCanvas(1280, 720)
  const g = canvas.getContext('2d')!
  const glow = (x: number, y: number, r: number, color: string) => {
    const radial = g.createRadialGradient(x, y, 0, x, y, r)
    radial.addColorStop(0, color)
    radial.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = radial
    g.fillRect(0, 0, 1280, 720)
  }
  if (kind === 'aurora') {
    const sky = g.createLinearGradient(0, 0, 0, 720)
    sky.addColorStop(0, '#0b1026')
    sky.addColorStop(1, '#141a3a')
    g.fillStyle = sky
    g.fillRect(0, 0, 1280, 720)
    glow(300, 200, 520, 'rgba(46, 204, 160, 0.55)')
    glow(900, 160, 480, 'rgba(90, 120, 255, 0.45)')
    glow(1100, 520, 420, 'rgba(170, 80, 220, 0.35)')
    glow(180, 600, 360, 'rgba(30, 160, 200, 0.3)')
  } else {
    const sky = g.createLinearGradient(0, 0, 0, 720)
    sky.addColorStop(0, '#2a1b4a')
    sky.addColorStop(0.45, '#c2507a')
    sky.addColorStop(0.75, '#f39a5b')
    sky.addColorStop(1, '#f7c873')
    g.fillStyle = sky
    g.fillRect(0, 0, 1280, 720)
    glow(820, 560, 300, 'rgba(255, 230, 170, 0.8)')
    glow(300, 160, 420, 'rgba(120, 70, 170, 0.35)')
  }
  return canvas
}
