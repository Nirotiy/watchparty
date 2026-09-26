import { useState } from "react"

import { MaterialSymbol } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { libraryKindLabel } from "@/lib/media-library-view"
import type { MediaLibraryKind } from "@/lib/ipc"

const KINDS: MediaLibraryKind[] = ["anime", "movie", "tv", "other"]

export interface MediaSourceDraft {
  name: string
  internalBaseUrl: string
  publicBaseUrl: string
  username: string
  password: string
  libraries: Array<{ name: string; kind: MediaLibraryKind; path: string }>
}

interface LibraryRow { name: string; kind: MediaLibraryKind; path: string }

/**
 * 加源表单（handoff §5 D5：只做新增，改/删留给后端或以后的设置页）。
 * 密码只活在打开期间的表单里：请求一落定立刻清空，不进 localStorage、不进日志。
 */
export function MediaSourceForm({ onCreate, onCancel }: {
  onCreate: (draft: MediaSourceDraft) => Promise<{ ok: true } | { ok: false; message: string }>
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [internalBaseUrl, setInternalBaseUrl] = useState("")
  const [publicBaseUrl, setPublicBaseUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [rows, setRows] = useState<LibraryRow[]>([{ name: "", kind: "movie", path: "/" }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function patchRow(index: number, patch: Partial<LibraryRow>) {
    setRows(current => current.map((row, position) => (position === index ? { ...row, ...patch } : row)))
  }

  const complete = name.trim() !== "" && internalBaseUrl.trim() !== "" && rows.every(row => row.name.trim() !== "" && row.path.trim() !== "")

  async function submit() {
    if (saving || !complete) return
    setSaving(true)
    setError("")
    let result: { ok: true } | { ok: false; message: string }
    try {
      result = await onCreate({
        name: name.trim(),
        internalBaseUrl: internalBaseUrl.trim(),
        publicBaseUrl: publicBaseUrl.trim() || internalBaseUrl.trim(),
        username: username.trim(),
        password,
        libraries: rows.map(row => ({ name: row.name.trim(), kind: row.kind, path: row.path.trim() })),
      })
    } finally {
      // 无论成败都不留密码。
      setPassword("")
      setSaving(false)
    }
    if (!result.ok) setError(result.message)
  }

  return (
    <form className="mt-4 border-y border-border py-3" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <MaterialSymbol name="library" className="size-4" />
        添加媒体源
        <span className="font-normal">保存前会逐个浅列库路径，任一路径不通就整体拒绝。</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="名称，如 第二台 OpenList" aria-label="源名称" className="h-8 text-xs" />
        <Input value={internalBaseUrl} onChange={(event) => setInternalBaseUrl(event.target.value)} placeholder="内网地址 https://files.example" aria-label="内网地址" className="h-8 font-mono text-xs" />
        <Input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="外网地址（留空同内网）" aria-label="外网地址" className="h-8 font-mono text-xs" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" aria-label="源用户名" className="h-8 text-xs" autoComplete="off" />
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" aria-label="源密码" className="h-8 text-xs" autoComplete="new-password" />
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input value={row.name} onChange={(event) => patchRow(index, { name: event.target.value })} placeholder="库名，如 Movies" aria-label="库名称" className="h-8 w-44 text-xs" />
            <Select value={row.kind} onValueChange={(value) => patchRow(index, { kind: value as MediaLibraryKind })}>
              <SelectTrigger className="h-8 w-24 text-xs" aria-label="库类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                {KINDS.map(kind => <SelectItem key={kind} value={kind}>{libraryKindLabel(kind)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input value={row.path} onChange={(event) => patchRow(index, { path: event.target.value })} placeholder="/media/Movies" aria-label="库路径" className="h-8 flex-1 font-mono text-xs" />
            <Button type="button" variant="ghost" size="icon" aria-label="删除这个库" disabled={rows.length <= 1}
              onClick={() => setRows(current => current.filter((_, position) => position !== index))}>
              <MaterialSymbol name="close" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={() => setRows(current => [...current, { name: "", kind: "other", path: "/" }])}>
          <MaterialSymbol name="add" />再加一个库
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" variant="accent" size="sm" disabled={saving || !complete}>{saving ? "正在验证…" : "保存源"}</Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>取消</Button>
        {error ? <span role="status" className="text-xs text-[var(--critical)]">{error}</span> : null}
      </div>
    </form>
  )
}
