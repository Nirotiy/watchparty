export interface CatalogAccepted {
  status: "accepted"
  libraryId: string
  running: true
}

export interface CatalogScan {
  libraryId: string
  files: number
  enumeratedAt: string | null
  rev: number
  running?: boolean
}

function networkFailure(error: unknown): boolean {
  return error instanceof TypeError || (typeof error === "object" && error !== null && "code" in error && error.code === "NETWORK_ERROR")
}

/** One POST, then read until the baseline advances. A stopped job is not a successful job. */
export async function refreshCatalog<T extends { running?: boolean }>(
  read: () => Promise<T>,
  post: () => Promise<unknown>,
  advanced: (current: T, before: T) => boolean,
  options: { wait?: () => Promise<void>; now?: () => number; timeoutMs?: number } = {},
): Promise<T> {
  const before = await read()
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? 120_000)
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 2_000)))
  try { await post() } catch (error) {
    if (!networkFailure(error)) throw error
    // The server may continue after a transport timeout. Never submit another POST.
  }
  while (now() < deadline) {
    try {
      const current = await read()
      if (current.running === false) {
        if (advanced(current, before)) return current
        throw Object.assign(new Error("后台任务已结束，但结果未更新。请检查服务端日志。"), { code: "CATALOG_REFRESH_NOT_LANDED" })
      }
      if (current.running === undefined && advanced(current, before)) return current
    } catch (error) {
      if (!networkFailure(error)) throw error
    }
    await wait()
  }
  throw Object.assign(new Error("等待后台任务超时。任务可能仍在运行，请稍后读取结果。"), { code: "CATALOG_REFRESH_TIMEOUT" })
}
