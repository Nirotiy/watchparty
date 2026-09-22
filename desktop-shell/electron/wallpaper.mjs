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
    if (cached?.key === key) return cached.dataUrl
    const image = nativeImage.createFromPath(transcoded)
    if (image.isEmpty()) { cached = { key, dataUrl: null }; return null }
    // Mica is effectively a heavily blurred wallpaper sample; a tiny thumbnail
    // upscaled and blurred in CSS is indistinguishable and keeps IPC light.
    const dataUrl = `data:image/jpeg;base64,${image.resize({ width: 128 }).toJPEG(70).toString('base64')}`
    cached = { key, dataUrl }
    return dataUrl
  } catch {
    return null
  }
}
