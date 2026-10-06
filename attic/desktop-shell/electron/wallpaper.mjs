import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'

// Windows transcodes the active wallpaper — including the current slideshow
// slide — into a JPEG copy at this fixed location, so reading it needs neither
// registry access nor native FFI. A solid-color desktop simply has no file and
// the renderer falls back to a plain tinted surface.
const transcoded = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')

let cached

export async function getWallpaperBackdrop() {
  try {
    const info = await stat(transcoded)
    const key = `${info.mtimeMs}:${info.size}`
    if (cached?.key === key) return cached.data
    const image = nativeImage.createFromPath(transcoded)
    if (image.isEmpty()) { cached = { key, data: null }; return null }
    // Mica is a flat wash of the theme base toward the wallpaper's average
    // brightness, with only a faint blurred sample left for life, so a 128px
    // thumbnail plus one mean value is all the renderer needs.
    const data = {
      dataUrl: `data:image/jpeg;base64,${image.resize({ width: 128 }).toJPEG(70).toString('base64')}`,
      average: safeAverage(image.resize({ width: 8, height: 8 })),
    }
    cached = { key, data }
    return data
  } catch {
    return null
  }
}

// Losing the mean colour should still leave the blurred sample intact, never
// take the whole backdrop down with it.
function safeAverage(image) {
  try {
    return averageRgb(image)
  } catch {
    return null
  }
}

function averageRgb(image) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  if (!width || !height || bitmap.length < width * height * 4) return null
  let red = 0
  let green = 0
  let blue = 0
  for (let i = 0; i < width * height; i += 1) {
    // nativeImage bitmaps are BGRA in memory.
    blue += bitmap[i * 4]
    green += bitmap[i * 4 + 1]
    red += bitmap[i * 4 + 2]
  }
  const count = width * height
  const [r, g, b] = [red, green, blue].map(channel => channel / count)
  // Mica blends the wallpaper in by luminosity, so its brightness reaches the
  // surface but its hue barely does — feeding the raw average through painted
  // the wallpaper's colours across the whole window instead of a neutral wash.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return `#${[r, g, b]
    .map(channel => Math.round(luma + (channel - luma) * 0.35))
    .map(channel => channel.toString(16).padStart(2, '0'))
    .join('')}`
}
