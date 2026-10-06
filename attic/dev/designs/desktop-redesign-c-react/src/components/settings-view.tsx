import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface SettingsViewProps {
  backendOrigin: string | null
  credentialsConfigured: boolean | null
  saving: boolean
  /** 需要 desktop 会话新增 IPC：写入系统凭据库并接通 native SiteBasicAuth */
  onSave: (username: string, password: string) => Promise<boolean>
  onClear: () => Promise<boolean>
  onBack: () => void
}

export function SettingsView({ backendOrigin, credentialsConfigured, saving, onSave, onClear, onBack }: SettingsViewProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || !username.trim() || !password) return
    if (await onSave(username.trim(), password)) {
      setNotice("已保存到系统凭据库")
      setPassword("")
    }
  }

  return (
    <section className="mx-auto grid h-full w-[min(680px,calc(100%-4rem))] content-center gap-5" aria-labelledby="settings-title">
      <div>
        <p className="mb-2 text-xs font-medium text-primary">设置</p>
        <h1 id="settings-title" className="text-2xl font-semibold tracking-tight">站点凭据</h1>
        <p className="mt-2 max-w-[68ch] text-sm leading-6 text-muted-foreground">
          站点凭据用于生产环境的 Caddy 全站 Basic Auth（所有 API 请求与 /p/ 回退播放）。
          保存后由 native 层写入系统凭据库，仅在内存中注入请求头——不会进入 WebView、URL、日志或房间数据。
        </p>
      </div>

      <form
        className="grid max-w-[430px] gap-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(event)
        }}
      >
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          后端地址
          <Input value={backendOrigin ?? ""} readOnly className="font-mono text-xs" aria-readonly />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          站点用户名
          <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          站点密码
          <Input
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            type="password"
            autoComplete="new-password"
          />
        </label>
        {notice ? <p className="text-xs text-muted-foreground" role="status">{notice}</p> : null}
        <div className="mt-1 flex items-center gap-2.5">
          <Button type="submit" disabled={saving}>保存到系统凭据库</Button>
          <Button type="button" variant="outline" onClick={() => void onClear()}>清除</Button>
          <span className="text-[11px] text-muted-foreground">
            {credentialsConfigured === true ? "已配置" : credentialsConfigured === false ? "未配置" : ""}
          </span>
        </div>
      </form>

      <Button variant="outline" className="w-fit" onClick={onBack}>返回房间</Button>
    </section>
  )
}
