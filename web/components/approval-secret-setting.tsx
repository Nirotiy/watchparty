"use client";

import { useState } from "react";
import { Save, Shield } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ApprovalSecretSetting() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true);
    setError("");
    try {
      const status = await api.approvalSecretStatus();
      setConfigured(status.configured);
      setEditing(true);
    } catch { setError("无法读取配置，请使用批准管理员账号验证身份。"); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const status = await api.setApprovalSecret(secret);
      setConfigured(status.configured);
      setEditing(false);
    } catch { setError("批准密钥保存失败"); }
    finally { setSecret(""); setBusy(false); }
  }
  return <section className="mb-4 border-y border-border bg-black py-3 text-white" aria-label="媒体库设置">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>批准密钥 · {configured === null ? "未读取" : configured ? "已配置 · ••••••••" : "未配置"}</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}><Shield className="size-4" />{configured ? "替换密钥" : "配置密钥"}</Button>
    </div>
    {editing ? <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm">批准密钥<Input type="password" autoComplete="new-password" value={secret} disabled={busy} onChange={event => setSecret(event.target.value)} /></label>
      <Button size="sm" disabled={busy || !/^[\x21-\x7e]{1,4096}$/.test(secret)} onClick={() => void save()}><Save className="size-4" />保存</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSecret(""); setEditing(false); }}>取消</Button>
    </div> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-red-400">{error}</p> : null}
  </section>;
}
