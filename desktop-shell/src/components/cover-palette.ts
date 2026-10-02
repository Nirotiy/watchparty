/**
 * Cover-derived accent. 40×40 offscreen canvas → 30° hue buckets → drop grey,
 * too-dark and too-bright pixels → the heaviest bucket becomes the accent and its
 * two runners-up feed the immersive background hues.
 *
 * 对比度护栏（M3）：hsl 的明度不是感知亮度——同一 l 下蓝和黄的对比度能差三倍，所以
 * 「clamp 明度」不足以保证 accent 与外壳底色的对比。产出前把明度沿远离底色的一侧推进，
 * 直到达到 WCAG 4.5:1（同时守住 accent 按钮上深/浅标签的对比）；推不到位返回 null,
 * 走调用方已有的「无取色」回退（默认主题 accent）。
 *
 * The canvas is only readable because the cover arrives as a data URL: a
 * cross-origin <img> taints it and `getImageData` throws.
 */
export type AccentVars = Record<string, string>

const SIZE = 40
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`

/** WCAG 相对亮度（sRGB，0..1 输入）。 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(lumA: number, lumB: number): number {
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05)
}

/** hsl → sRGB（0..1）。 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    const x = ((t % 1) + 1) % 1
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)]
}

// 外壳底色：暗色取房间播放条底（--base-tertiary #0a0a0a），亮色取 --base #f3f3f3。
const SHELL_LUMINANCE = { dark: relativeLuminance(10 / 255, 10 / 255, 10 / 255), light: relativeLuminance(243 / 255, 243 / 255, 243 / 255) }
const ACCENT_MIN_CONTRAST = 4.5

export function guardAccentLightness(h: number, s: number, lightness: number, dark: boolean): number | null {
  const shell = dark ? SHELL_LUMINANCE.dark : SHELL_LUMINANCE.light
  const direction = dark ? 0.01 : -0.01
  let candidate = lightness
  for (let step = 0; step <= 40; step++) {
    const [r, g, b] = hslToRgb(h, s, candidate)
    if (contrastRatio(relativeLuminance(r, g, b), shell) >= ACCENT_MIN_CONTRAST) return Math.round(candidate * 1000) / 1000
    candidate += direction
    if (candidate > 0.92 || candidate < 0.08) return null
  }
  return null
}

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
  const baseLightness = dark ? clamp(main.l, 0.62, 0.78) : clamp(main.l, 0.30, 0.46)
  const lightness = guardAccentLightness(main.h, saturation, baseLightness, dark)
  if (lightness === null) return null
  // hover 也过同一道护栏（亮色下朝亮走会跌对比），兜不住就落回基准色；
  // press 的压暗不能被下限抬回亮侧（黄系亮色封面最低压到 0.24，原下限 0.2 会反相）。
  const hoverBase = dark ? clamp(lightness + 0.07, 0.6, 0.86) : clamp(lightness + 0.08, 0.3, 0.55)
  const hover = guardAccentLightness(main.h, saturation, hoverBase, dark) ?? lightness
  const pressBase = dark ? clamp(lightness - 0.10, 0.5, 0.7) : clamp(lightness - 0.08, 0.2, 0.4)
  const press = Math.min(pressBase, lightness - 0.02)
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
