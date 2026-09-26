import { useEffect, useRef, useState } from "react"
import Kawarp from "@kawarp/core"

/**
 * Immersive background layer, per the lyrics-panel spec §12:
 *   route A — @kawarp/core (MIT) WebGL Kawase blur + domain warp of the cover;
 *   route B — static CSS blur of the same cover, used when WebGL is unavailable
 *             (`--disable-gpu`, driver blacklist, remote desktop) or the user turned
 *             the effect off. The palette gradient under both stays as the base.
 *
 * Notes that are easy to get wrong: the canvas may never take pointer events, the
 * render size is the container size × min(dpr, 1.25) capped near 2.6 MP, resize is
 * throttled, rendering stops while the window is hidden, the instance is reused
 * across tracks (a fresh WebGL context per track exhausts the context quota) and
 * disposed with the view.
 */
const MAX_PIXELS = 2_600_000
const RESIZE_THROTTLE_MS = 120

type KawarpBackgroundProps = {
  cover: string | null
  active: boolean
  dark: boolean
  onDegrade: (reason: string) => void
}

export function KawarpBackground({ cover, active, dark, onDegrade }: KawarpBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const instanceRef = useRef<Kawarp | null>(null)
  const degradedRef = useRef(false)
  const [painted, setPainted] = useState(false)
  // Route B crossfades between two layers so a track change never flashes.
  const [layers, setLayers] = useState<{ a: string | null; b: string | null; top: "a" | "b" }>({ a: null, b: null, top: "b" })
  const webgl = active && Boolean(cover) && !degradedRef.current

  useEffect(() => {
    if (!cover) { setLayers({ a: null, b: null, top: "b" }); return }
    setLayers(current => current.top === "b"
      ? { a: cover, b: current.b, top: "a" }
      : { a: current.a, b: cover, top: "b" })
  }, [cover])

  useEffect(() => {
    if (!webgl || !cover) {
      const instance = instanceRef.current
      instanceRef.current = null
      instance?.dispose()
      setPainted(false)
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    let instance = instanceRef.current
    if (!instance) {
      try {
        instance = new Kawarp(canvas, {
          warpIntensity: 0.8,
          blurPasses: 8,
          animationSpeed: 0.12,
          saturation: 1.35,
          scale: 1.05,
          transitionDuration: 700,
          tintColor: dark ? [0.125, 0.125, 0.125] : [0.9, 0.89, 0.87],
          tintIntensity: 0.12,
          dithering: 0.008,
        })
      } catch (error) {
        degradedRef.current = true
        onDegrade(error instanceof Error ? error.message : "webgl_unavailable")
        setPainted(false)
        return
      }
      instanceRef.current = instance
    }
    let live = true
    const tint = dark ? [0.125, 0.125, 0.125] : [0.9, 0.89, 0.87]
    instance.tintColor = tint as [number, number, number]
    const resize = () => {
      const host = hostRef.current
      if (!host || !instanceRef.current) return
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25)
      const rect = host.getBoundingClientRect()
      let width = Math.max(1, Math.round(rect.width * ratio))
      let height = Math.max(1, Math.round(rect.height * ratio))
      if (width * height > MAX_PIXELS) {
        const factor = Math.sqrt(MAX_PIXELS / (width * height))
        width = Math.max(1, Math.round(width * factor))
        height = Math.max(1, Math.round(height * factor))
      }
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      instanceRef.current.resize()
    }
    resize()
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, RESIZE_THROTTLE_MS)
    })
    if (hostRef.current) observer.observe(hostRef.current)
    const image = new Image()
    image.onload = () => {
      if (!live || !instanceRef.current) return
      instanceRef.current.loadImageElement(image)
      instanceRef.current.start()
      setPainted(true)
    }
    image.src = cover
    const onVisibility = () => {
      if (!instanceRef.current) return
      if (document.hidden) instanceRef.current.stop()
      else instanceRef.current.start()
    }
    document.addEventListener("visibilitychange", onVisibility)
    if (document.hidden) instance.stop()
    return () => {
      live = false
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [webgl, cover, dark, onDegrade])

  useEffect(() => () => { instanceRef.current?.dispose(); instanceRef.current = null }, [])

  return (
    <div className="imm-bg" aria-hidden="true" ref={hostRef}>
      <div className={`imm-bg-cover${layers.top === "a" ? " on" : ""}`} style={layers.a ? { backgroundImage: `url("${layers.a}")` } : undefined} />
      <div className={`imm-bg-cover${layers.top === "b" ? " on" : ""}`} style={layers.b ? { backgroundImage: `url("${layers.b}")` } : undefined} />
      {webgl ? <canvas className={painted ? "imm-bg-canvas ready" : "imm-bg-canvas"} ref={canvasRef} /> : null}
    </div>
  )
}
