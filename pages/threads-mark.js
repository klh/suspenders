// <threads-mark> — the Dynamic Identity stitch as an embeddable badge.
// Dependency-free twin of the generator on threads.dk (src/lib/mark.ts):
// same mulberry32 PRNG, same generateMark, same drawing rules. Keep the
// two files in sync if the mark's rules change.
//
// Usage (classic script — no CORS needed, works cross-origin):
//   <script src="https://threads.dk/embed/threads-mark.js"></script>
//   <threads-mark size="28"></threads-mark>
// (Also valid as <script type="module"> same-origin.)
// Attributes:
//   size     — rendered edge in px (default 28)
//   cadence  — ms between fresh generations (default 500)
//   seed     — freeze one generation instead of cycling
//   borderless — drop the hairline card edge
//   transparent — the stitch alone: no card fill, no edge (for badges that
//     sit on a page's own background)
// Reduced motion: one frozen generation (seed 77), no cycle.

// Page tokens cross the shadow boundary; same defaults as <dynamic-mark>.
const FALLBACKS = { paper: "#faf8f4", thread: "#af2f12", hair: "rgba(32,29,26,.16)" }

function colorsFrom(host) {
  const cs = getComputedStyle(host)
  return {
    paper: cs.getPropertyValue("--paper").trim() || FALLBACKS.paper,
    thread: cs.getPropertyValue("--rust").trim() || FALLBACKS.thread,
    hair: cs.getPropertyValue("--hair").trim() || FALLBACKS.hair,
  }
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateMark(seed) {
  const rng = mulberry32(seed)
  const margin = 20
  const horizontal = rng() < 0.5
  const peakCount = 6 + Math.floor(rng() * 5)
  const step = (100 - margin * 2) / peakCount
  const amplitude = 7 + rng() * 5
  const centerline = 38 + rng() * 24
  const points = []
  for (let i = 0; i <= peakCount; i++) {
    const along = margin + step * i
    const side = i % 2 === 0 ? -1 : 1
    const jitterAlong = (rng() - 0.5) * step * 0.15
    const jitterAmp = (rng() - 0.5) * 2
    const offset = side * (amplitude + jitterAmp)
    points.push(
      horizontal
        ? { x: along + jitterAlong, y: centerline + offset }
        : { x: centerline + offset, y: along + jitterAlong },
    )
  }
  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  let dx = last.x - prev.x
  let dy = last.y - prev.y
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len
  const tailFrom = points.length - 1
  points.push(
    { x: last.x + dx * 10 + (rng() - 0.5) * 4, y: last.y + dy * 10 + 4 + (rng() - 0.5) * 3 },
    { x: last.x + dx * 16 + (rng() - 0.5) * 10, y: last.y + dy * 16 + 12 + rng() * 6 },
  )
  return { points, tailFrom }
}

class ThreadsMark extends HTMLElement {
  static get observedAttributes() {
    return ["size", "cadence", "seed"]
  }

  constructor() {
    super()
    const root = this.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent = ":host{display:inline-block;line-height:0}canvas{display:block}"
    this._cv = document.createElement("canvas")
    root.append(style, this._cv)
    this._timer = 0
  }

  connectedCallback() {
    this._start()
  }

  disconnectedCallback() {
    clearInterval(this._timer)
  }

  attributeChangedCallback() {
    if (this.isConnected) this._start()
  }

  _start() {
    clearInterval(this._timer)
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
    const cadence = Math.max(250, parseInt(this.getAttribute("cadence") || "500", 10) || 500)
    if (!reduce && !this.hasAttribute("seed")) {
      this._timer = setInterval(() => this._draw(), cadence)
    }
    this._draw()
  }

  _draw() {
    const size = Math.max(8, parseInt(this.getAttribute("size") || "28", 10) || 28)
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const seedAttr = this.getAttribute("seed")
    const seed = seedAttr == null ? Math.floor(Math.random() * 1e9) : Number(seedAttr) || 0
    const mark = generateMark(seed)
    const s = size / 100
    const px = Math.round(size * dpr)
    const cv = this._cv
    cv.width = px
    cv.height = px
    cv.style.width = size + "px"
    cv.style.height = size + "px"
    const ctx = cv.getContext("2d")
    if (!ctx) return
    const r = px * 0.16
    const colors = colorsFrom(this)
    const bare = this.hasAttribute("transparent") // stitch only: no card, no edge
    ctx.clearRect(0, 0, px, px)
    if (!bare) {
      ctx.beginPath()
      ctx.roundRect(0, 0, px, px, r)
      ctx.fillStyle = colors.paper
      ctx.fill()
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(0, 0, px, px, r)
      ctx.clip()
    }
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = colors.thread
    // Stroke in device pixels with the same size tiers as <dynamic-mark>.
    const strokeBase = size <= 20 ? 1.4 : size <= 48 ? 1.1 : 0.9
    for (let i = 1; i < mark.points.length; i++) {
      const a = mark.points[i - 1]
      const b = mark.points[i]
      const taper = i >= mark.tailFrom ? 1 - 0.35 * ((i - mark.tailFrom + 1) / 2) : 1
      ctx.lineWidth = strokeBase * dpr * Math.max(0.45, taper)
      ctx.beginPath()
      ctx.moveTo(a.x * s * dpr, a.y * s * dpr)
      ctx.lineTo(b.x * s * dpr, b.y * s * dpr)
      ctx.stroke()
    }
    if (!bare) ctx.restore()
    if (!bare && !this.hasAttribute("borderless")) {
      ctx.beginPath()
      ctx.roundRect(0.5, 0.5, px - 1, px - 1, r)
      ctx.strokeStyle = colors.hair
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}

if (!customElements.get("threads-mark")) {
  customElements.define("threads-mark", ThreadsMark)
}
