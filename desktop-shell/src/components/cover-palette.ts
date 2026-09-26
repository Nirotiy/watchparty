/**
 * Cover-derived accent. 40×40 offscreen canvas → 30° hue buckets → drop grey,
 * too-dark and too-bright pixels → the heaviest bucket becomes the accent and its
 * two runners-up feed the immersive background hues. Both light and dark targets
 * clamp lightness so contrast against the shell is preserved.
 *
 * The canvas is only readable because the cover arrives as a data URL: a
 * cross-origin <img> taints it and `getImageData` throws.
 */
export type AccentVars = Record<string, string>

const SIZE = 40
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`

interface Hsl { h: number; s: number; l: number }

function toHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const saturation = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r) h = (g - b) / delta + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }
  return { h: h * 60, s: saturation, l }
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

export async function accentVars(dataUrl: string, dark: boolean): Promise<AccentVars | null> {
  const image = await loadImage(dataUrl)
  if (!image) return null
  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, SIZE, SIZE)
  let pixels: Uint8ClampedArray
  try { pixels = context.getImageData(0, 0, SIZE, SIZE).data } catch { return null }
  const buckets = new Map<number, { weight: number; count: number; r: number; g: number; b: number }>()
  for (let i = 0; i < pixels.length; i += 4) {
    const r = (pixels[i] ?? 0) / 255
    const g = (pixels[i + 1] ?? 0) / 255
    const b = (pixels[i + 2] ?? 0) / 255
    const { h, s, l } = toHsl(r, g, b)
    if (s < 0.22 || l < 0.18 || l > 0.9) continue
    const key = Math.floor(h / 30)
    const weight = s * (1 - Math.abs(l - 0.5) * 1.1)
    const bucket = buckets.get(key) ?? { weight: 0, count: 0, r: 0, g: 0, b: 0 }
    bucket.weight += weight
    bucket.r += r
    bucket.g += g
    bucket.b += b
    bucket.count += 1
    buckets.set(key, bucket)
  }
  if (!buckets.size) return null
  const ranked = [...buckets.values()].sort((left, right) => right.weight - left.weight)
  const stops: Hsl[] = ranked.slice(0, 3).map(bucket => toHsl(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count))
  const main = stops[0]
  if (!main) return null
  const saturation = clamp(main.s, 0.42, 0.85)
  const lightness = dark ? clamp(main.l, 0.62, 0.78) : clamp(main.l, 0.30, 0.46)
  const hover = dark ? clamp(lightness + 0.07, 0.6, 0.86) : clamp(lightness + 0.08, 0.3, 0.55)
  const press = dark ? clamp(lightness - 0.10, 0.5, 0.7) : clamp(lightness - 0.08, 0.2, 0.4)
  const surface = hsl(main.h, saturation, lightness)
  const vars: AccentVars = {
    "--accent": surface,
    "--accent-hover": hsl(main.h, saturation, hover),
    "--accent-press": hsl(main.h, saturation, press),
    "--fg-on-accent": lightness > 0.6 ? "#0a0a0a" : "#fff",
    "--bar-accent": surface,
    "--bar-accent-hover": hsl(main.h, saturation, hover),
    "--bar-accent-press": hsl(main.h, saturation, press),
  }
  const palette = [stops[0], stops[1] ?? main, stops[2] ?? main]
  palette.forEach((stop, index) => {
    vars[`--imm-c${index + 1}`] = hsl(stop.h, clamp(stop.s, 0.35, 0.7), dark ? clamp(stop.l, 0.34, 0.5) : clamp(stop.l, 0.68, 0.8))
    vars[`--imm-g${index + 1}`] = hsl(stop.h, clamp(stop.s, 0.25, 0.5), dark ? clamp(stop.l, 0.06, 0.16) * (1 - index * 0.25) + index * 0.02 : clamp(stop.l, 0.88, 0.96))
  })
  return vars
}
