
export type UnlistenFn = () => void
interface DesktopBridge {
  readonly runtime: "electron"
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (event: { payload: T }) => void): UnlistenFn
}
declare global { interface Window { watchpartyDesktop?: DesktopBridge } }

/** Electron bridge stays at one boundary; domain adapters keep their injected transport. */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return window.watchpartyDesktop ? window.watchpartyDesktop.invoke<T>(command, args) : Promise.reject(new Error("desktop_runtime_unavailable"))
}
export function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  return window.watchpartyDesktop ? Promise.resolve(window.watchpartyDesktop.listen(event, handler)) : Promise.reject(new Error("desktop_runtime_unavailable"))
}
export function isDesktopRuntime(): boolean { return Boolean(window.watchpartyDesktop) }
