import { useEffect, useState } from "react"
import {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel,
  Button, Dropdown, Field, Input, MessageBar, MessageBarBody, MessageBarTitle,
  Option, Slider, Switch, Tab, TabList, Text, Textarea,
} from "@fluentui/react-components"
import {
  CheckmarkCircleRegular, DeleteRegular, GlobeRegular,
  PlayCircleRegular, SaveRegular, SettingsRegular, ShieldRegular, WarningRegular,
} from "@fluentui/react-icons"
import type { DesktopUiState } from "@/lib/contracts"
import { useShellToast } from "@/components/shell-toast"
import {
  backendAddressError, clearSiteCredentials, deleteOriginTrust, errorMessage, getDesktopSettings, importOriginTrust,
  listOriginTrust, listAudioOutputDevices, promptSiteCredentials, updateDesktopSettings, verifyBackend,
  type AudioOutputDevice,
  type DesktopSettingsStatus, type OriginTrustRecord, type PlayerPreferences,
} from "@/lib/ipc"

type Theme = "dark" | "light"
type SettingsSection = "general" | "network" | "playback" | "security"

const sections: Array<{ value: SettingsSection; label: string; icon: typeof SettingsRegular }> = [
  { value: "general", label: "基础", icon: SettingsRegular },
  { value: "network", label: "连接", icon: GlobeRegular },
  { value: "playback", label: "播放", icon: PlayCircleRegular },
  { value: "security", label: "安全与高级", icon: ShieldRegular },
]

function connectionLabel(connection?: DesktopUiState["connection"]): string {
  if (connection === "connecting") return "正在连接"
  if (connection === "ready") return "已连接"
  if (connection === "backoff") return "网络重试中"
  if (connection === "expired") return "会话已过期"
  if (connection === "failed") return "连接失败"
  return "等待加入"
}

function useSettingsMessage(initialMessage = "") {
  const notify = useShellToast()
  const [notice, setNotice] = useState<{ message: string; intent: "info" | "success" | "warning" | "error" }>({ message: initialMessage, intent: "info" })
  function setMessage(message: string, intent: typeof notice.intent = "info") {
    if (message && intent === "success") {
      notify(message, "success")
      setNotice({ message: "", intent: "info" })
    } else setNotice({ message, intent })
  }
  return { ...notice, setMessage }
}

function StatusMessage({ message, intent = "info" }: { message: string; intent?: "info" | "success" | "warning" | "error" }) {
  if (!message) return null
  const Icon = intent === "error" || intent === "warning" ? WarningRegular : CheckmarkCircleRegular
  return <MessageBar intent={intent} layout="multiline" className="fluent-settings-message"><MessageBarBody><MessageBarTitle><Icon /> 状态</MessageBarTitle>{message}</MessageBarBody></MessageBar>
}

function SettingsRow({ children, description, label }: { children: React.ReactNode; description: string; label: string }) {
  return <div className="fluent-settings-row"><div className="fluent-settings-copy"><Text weight="semibold">{label}</Text><Text size={200}>{description}</Text></div><div className="fluent-settings-control">{children}</div></div>
}

function SettingsHeading({ title, detail }: { title: string; detail: string }) {
  return <header className="fluent-settings-heading"><Text as="h1" size={600} weight="semibold">{title}</Text><Text size={300}>{detail}</Text></header>
}

export function FluentSettingsView({ state, theme, onThemeChange, windowMaterial, onWindowMaterialChange, musicPartyOrigin, onMusicPartyLogout }: {
  state: DesktopUiState | null
  theme: Theme
  onThemeChange: () => Promise<void>
  windowMaterial: "auto" | "none"
  onWindowMaterialChange: () => Promise<void>
  musicPartyOrigin: string
  onMusicPartyLogout: () => Promise<void>
}) {
  const [section, setSection] = useState<SettingsSection>("general")
  return <div className="fluent-settings-provider">
    <div className="fluent-settings-layout">
      <nav className="fluent-settings-nav" aria-label="设置分类">
        <Text as="h2" size={500} weight="semibold" className="fluent-settings-nav-title">设置</Text>
        <TabList selectedValue={section} onTabSelect={(_, data) => setSection(data.value as SettingsSection)}>
          {sections.map(({ value, label, icon: Icon }) => <Tab key={value} value={value} icon={<Icon />}>{label}</Tab>)}
        </TabList>
      </nav>
      <section key={section} className="fluent-settings-content" aria-label="设置内容" tabIndex={0}>
        <div className="fluent-settings-content-stack">
        {section === "general" ? <GeneralPanel theme={theme} onThemeChange={onThemeChange} windowMaterial={windowMaterial} onWindowMaterialChange={onWindowMaterialChange} /> : null}
        {section === "playback" ? <PlaybackPanel state={state} /> : null}
        {section === "network" ? <NetworkPanel state={state} /> : null}
        {section === "security" ? <SecurityPanel musicPartyOrigin={musicPartyOrigin} onLogout={onMusicPartyLogout} /> : null}
        </div>
      </section>
    </div>
  </div>
}

function GeneralPanel({ theme, onThemeChange, windowMaterial, onWindowMaterialChange }: { theme: Theme; onThemeChange: () => Promise<void>; windowMaterial: "auto" | "none"; onWindowMaterialChange: () => Promise<void> }) {
  const notify = useShellToast()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function save(action: () => Promise<void>, fallback: string) {
    setBusy(true); setError("")
    try { await action(); notify("外观设置已保存", "success") }
    catch (error) { setError(errorMessage(error, fallback)) }
    finally { setBusy(false) }
  }
  return <><SettingsHeading title="基础" detail="调整桌面端的外观和窗口行为。" /><div className="fluent-settings-group"><SettingsRow label="应用主题" description="主题会保存到本机设置，并同步原生标题栏。"><Switch disabled={busy} checked={theme === "dark"} label={theme === "dark" ? "深色" : "浅色"} onChange={() => void save(onThemeChange, "主题保存失败")} /></SettingsRow><SettingsRow label="窗口材质" description="跟随系统时使用 Windows Mica；系统不支持或关闭透明效果时使用纯色。"><Switch disabled={busy} checked={windowMaterial === "auto"} label={windowMaterial === "auto" ? "跟随系统" : "关闭"} onChange={() => void save(onWindowMaterialChange, "窗口材质保存失败")} /></SettingsRow></div><StatusMessage message={error} intent="error" /></>
}

function CredentialsPanel() {
  const [status, setStatus] = useState<DesktopSettingsStatus | null>(null)
  const { message, intent, setMessage } = useSettingsMessage("正在读取站点登录状态…")
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getDesktopSettings().then(value => { setStatus(value); setMessage(value.backendOrigin ? "" : "请先到“连接”保存 Banguru 服务器地址") }).catch(error => setMessage(errorMessage(error, "无法读取站点登录状态"), "error")) }, [])
  async function prompt() {
    setBusy(true); setMessage("等待系统凭据对话框…")
    try { const result = await promptSiteCredentials(); if (result) { setStatus(result); setMessage("凭据已保存，请重新加入房间", "success") } else setMessage("已取消，凭据未更改") }
    catch (error) { setMessage(errorMessage(error, "凭据录入失败"), "error") } finally { setBusy(false) }
  }
  async function clear() {
    setBusy(true)
    try { setStatus(await clearSiteCredentials()); setMessage("凭据已清除，原会话已停止", "success") }
    catch (error) { setMessage(errorMessage(error, "清除凭据失败"), "error") } finally { setBusy(false) }
  }
  async function verify() {
    setBusy(true); setMessage("正在验证已保存的服务器地址…")
    try { await verifyBackend(); setMessage("服务器连接正常，可以重新加入 Banguru 房间。", "success") }
    catch { setMessage("无法验证连接。请在“连接”检查服务器地址，并确认服务器已启动、站点账号和密码正确。", "error") } finally { setBusy(false) }
  }
  return <><Text as="p">仅在 Banguru 服务器要求站点账号和密码时设置。这与房间密码不同。</Text><Text as="p">密码保存在 Windows 凭据管理器中，界面无法读回。替换或清除会结束当前 Banguru 房间会话，之后需要重新加入。</Text><div className="fluent-settings-group"><SettingsRow label="站点登录（Basic Auth）" description={status?.backendOrigin ?? "尚未设置服务器地址"}><Text>{status?.credentialsConfigured ? "已保存账号和密码" : "未设置"}</Text></SettingsRow></div><div className="fluent-settings-actions"><Button appearance="primary" disabled={busy || !status?.backendOrigin} onClick={() => void prompt()}>{status?.credentialsConfigured ? "更换账号和密码" : "设置账号和密码"}</Button><Button disabled={busy || !status?.credentialsConfigured} onClick={() => void clear()}>清除账号和密码</Button><Button appearance="subtle" disabled={busy || !status?.backendOrigin} onClick={() => void verify()}>验证已保存的连接</Button></div><StatusMessage message={message} intent={intent} /></>
}

function PlaybackPanel({ state }: { state: DesktopUiState | null }) {
  const [preferences, setPreferences] = useState<PlayerPreferences | null>(null)
  const [failures, setFailures] = useState<string[]>([])
  const { message, intent, setMessage } = useSettingsMessage()
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getDesktopSettings().then(settings => { setPreferences(settings.playerPreferences); setFailures(settings.playerPreferenceFailures ?? []) }).catch(error => setMessage(errorMessage(error, "无法读取播放设置"), "error")) }, [])
  const patch = (value: Partial<PlayerPreferences>) => setPreferences(current => current ? { ...current, ...value } : current)
  async function save() {
    if (!preferences) return
    setBusy(true)
    try {
      const current = await getDesktopSettings()
      const updated = await updateDesktopSettings({ backendOrigin: current.backendOrigin, nickname: current.nickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: preferences })
      setPreferences(updated.playerPreferences); setFailures(updated.playerPreferenceFailures ?? [])
      const partiallyApplied = (updated.playerPreferenceFailures ?? []).length > 0
      setMessage(partiallyApplied ? "已保存，部分即时项未能应用到当前播放器" : "播放设置已保存", partiallyApplied ? "warning" : "success")
    } catch (error) { setMessage(errorMessage(error, "播放设置保存失败"), "error") } finally { setBusy(false) }
  }
  if (!preferences) return <><SettingsHeading title="播放" detail="设置这台电脑上的画面、声音和字幕。" /><StatusMessage message={message || "正在读取…"} intent={intent} /></>
  return <><SettingsHeading title="播放" detail="仅影响本机播放。修改后点击“保存播放设置”；离开本页会丢弃未保存的修改。" /><Text as="h2" size={400} weight="semibold">画面与声音</Text><div className="fluent-settings-group">
    <SettingsRow label="硬件解码" description="使用显卡解码视频，减少处理器负担。播放器重新创建后生效。"><Choice value={preferences.hardwareDecoding} choices={[["auto-safe", "自动（兼容优先）"], ["auto", "自动"], ["no", "关闭"]]} onChange={value => patch({ hardwareDecoding: value as PlayerPreferences["hardwareDecoding"] })} /></SettingsRow>
    <SettingsRow label="去隔行" description="减少隔行视频的梳齿边缘。一般保持自动，保存后尝试应用。"><Choice value={preferences.deinterlace} choices={[["auto", "自动"], ["on", "开"], ["off", "关"]]} onChange={value => patch({ deinterlace: value as PlayerPreferences["deinterlace"] })} /></SettingsRow>
    <SettingsRow label="HDR 输出" description="保存后立即尝试应用"><Choice value={preferences.hdr} choices={[["auto", "跟随默认"], ["sdr", "转 SDR"], ["passthrough", "原样"]]} onChange={value => patch({ hdr: value as PlayerPreferences["hdr"] })} /></SettingsRow>
    <SettingsRow label="音频输出设备" description="从本机读取可用设备，保存后尝试应用"><AudioDeviceChoice value={preferences.audioDevice} onChange={audioDevice => patch({ audioDevice })} /></SettingsRow>
    <SettingsRow label="声道" description="保存后立即尝试应用，不做 bitstream 直通"><Choice value={preferences.channelLayout} choices={[["auto", "自动"], ["stereo", "立体声"]]} onChange={value => patch({ channelLayout: value as PlayerPreferences["channelLayout"] })} /></SettingsRow>
    <SettingsRow label="默认音量" description={`${preferences.defaultVolume}% ，新建播放器时生效`}><VolumeControl value={preferences.defaultVolume} onChange={value => patch({ defaultVolume: value })} /></SettingsRow>
  </div><Text as="h2" size={400} weight="semibold">语言与字幕</Text><div className="fluent-settings-group">
    <SettingsRow label="首选音轨语言" description="按顺序选择可用语言。chi,eng 表示中文优先、英文其次，下次载入生效。"><Input aria-label="首选音轨语言" value={preferences.audioLanguage} placeholder="默认" onChange={event => patch({ audioLanguage: event.target.value })} /></SettingsRow>
    <SettingsRow label="字幕语言顺序" description="用逗号分隔语言代码，如 chi,eng。留空使用默认，下次载入生效。"><Input aria-label="字幕语言顺序" value={preferences.subtitleLanguage} placeholder="默认" onChange={event => patch({ subtitleLanguage: event.target.value })} /></SettingsRow>
    <SettingsRow label="字幕字体" description="保存后立即尝试应用，仅限非 ASS 文本字幕"><Input value={preferences.subtitleFont} placeholder="系统默认" onChange={event => patch({ subtitleFont: event.target.value })} /></SettingsRow>
    <SettingsRow label="字幕相对字号" description={`×${preferences.subtitleScale.toFixed(1)}，保存后立即尝试应用`}><NumberSlider value={preferences.subtitleScale} min={0.5} max={3} step={0.1} onChange={value => patch({ subtitleScale: value })} /></SettingsRow>
    <SettingsRow label="ASS 样式覆盖" description="开启后使用上面的字体和字号覆盖内嵌样式"><Switch checked={preferences.subtitleAssOverride} label={preferences.subtitleAssOverride ? "覆盖开" : "尊重原样式"} onChange={(_, data) => patch({ subtitleAssOverride: data.checked })} /></SettingsRow>
    <SettingsRow label="字幕延迟" description={`${preferences.subtitleDelay.toFixed(1)}s，保存后立即尝试应用，换片重置`}><NumberSlider value={preferences.subtitleDelay} min={-30} max={30} step={0.5} onChange={value => patch({ subtitleDelay: value })} /></SettingsRow>
  </div><Text as="h2" size={400} weight="semibold">播放缓存与网络</Text><div className="fluent-settings-group">
    <SettingsRow label="缓存预设" description="重建播放器后生效"><Choice value={preferences.cacheProfile} choices={[["auto", "自动"], ["low-latency", "低延迟"], ["stable", "稳定"]]} onChange={value => patch({ cacheProfile: value as PlayerPreferences["cacheProfile"] })} /></SettingsRow>
    <SettingsRow label="网络超时" description={`${preferences.networkTimeout}s，下次载入生效，范围 5 至 120`}><Input type="number" min={5} max={120} value={String(preferences.networkTimeout)} onChange={event => patch({ networkTimeout: Math.min(120, Math.max(5, Number(event.target.value) || 30)) })} /></SettingsRow>
  </div><div className="fluent-settings-actions"><Button appearance="primary" icon={<SaveRegular />} disabled={busy} onClick={() => void save()}>保存播放设置</Button></div><StatusMessage message={message} intent={intent} />{failures.length ? <StatusMessage message={`未生效项：${failures.join("、")}。这些值会在下次重建播放器时重试。`} intent="warning" /> : null}{state?.capability ? <Text size={200} className="fluent-settings-capability">当前生效：hwdec={state.capability.hwdec ?? state.capability.hwdecConfigured ?? "-"}，vo={state.capability.vo ?? "-"}</Text> : null}</>
}

function Choice({ value, choices, onChange }: { value: string; choices: Array<[string, string]>; onChange: (value: string) => void }) {
  const label = choices.find(([optionValue]) => optionValue === value)?.[1] ?? value
  return <Dropdown value={label} selectedOptions={[value]} onOptionSelect={(_, data) => { if (data.optionValue) onChange(data.optionValue) }}><>{choices.map(([optionValue, optionLabel]) => <Option key={optionValue} value={optionValue}>{optionLabel}</Option>)}</></Dropdown>
}

function AudioDeviceChoice({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  async function refresh() {
    setLoading(true)
    setError("")
    try { setDevices(await listAudioOutputDevices()) }
    catch { setError("无法读取设备列表，请重试；当前选择未改变。") }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  const selected = value && value !== "auto" ? value : "auto"
  const available = devices.find(device => device.id === selected)
  const label = selected === "auto" ? "系统默认" : available?.name ?? `${selected}（当前不可用）`
  return <Field validationMessage={error || undefined} validationState={error ? "warning" : "none"}>
    <Dropdown aria-label="音频输出设备" value={label} selectedOptions={[selected]} onOptionSelect={(_, data) => { if (data.optionValue) onChange(data.optionValue === "auto" ? null : data.optionValue) }}>
      <Option value="auto">系统默认</Option>
      {selected !== "auto" && !available ? <Option value={selected}>{label}</Option> : null}
      {devices.map(device => <Option key={device.id} value={device.id}>{device.name}</Option>)}
    </Dropdown>
    <Button appearance="subtle" disabled={loading} onClick={() => void refresh()}>{loading ? "正在读取…" : "刷新设备"}</Button>
  </Field>
}

function NumberSlider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <div className="fluent-settings-slider"><Slider value={value} min={min} max={max} step={step} onChange={(_, data) => onChange(data.value)} /><Text size={200}>{value.toFixed(step < 1 ? 1 : 0)}</Text></div>
}

function VolumeControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="fluent-settings-volume" title="双击恢复 100%" onDoubleClick={() => onChange(100)}>
    <Slider value={value} min={0} max={100} aria-label="默认音量" onChange={(_, data) => onChange(data.value)} />
    <Text size={200}>{value}%</Text>
  </div>
}

function NetworkPanel({ state }: { state: DesktopUiState | null }) {
  const [origin, setOrigin] = useState("")
  const [settings, setSettings] = useState<DesktopSettingsStatus | null>(null)
  const { message, intent, setMessage } = useSettingsMessage()
  const [busy, setBusy] = useState(false)
  const addressError = backendAddressError(origin)
  useEffect(() => { void getDesktopSettings().then(value => { setSettings(value); setOrigin(value.backendOrigin ?? "") }).catch(error => setMessage(errorMessage(error, "无法读取设置"), "error")) }, [])
  async function save() {
    if (addressError) return
    setBusy(true)
    try { const current = await getDesktopSettings(); const updated = await updateDesktopSettings({ backendOrigin: origin.trim() || null, nickname: current.nickname, theme: current.theme, windowMaterial: current.windowMaterial, playerPreferences: current.playerPreferences }); setSettings(updated); setOrigin(updated.backendOrigin ?? ""); setMessage(updated.backendOrigin !== current.backendOrigin ? "站点已更新，请验证连接后重新加入房间" : "服务器地址已保存", "success") }
    catch (error) { setMessage(errorMessage(error, "设置保存失败"), "error") } finally { setBusy(false) }
  }
  async function verify() {
    if (addressError || backendAddressError(settings?.backendOrigin ?? "")) return
    setBusy(true); setMessage("正在验证已保存的服务器地址…")
    try { await verifyBackend(); setMessage("服务器连接正常，可以返回 Banguru 加入房间。", "success") }
    catch { setMessage("无法验证连接。请检查保存的地址和服务器是否已启动；本机后端应使用 18082，不是用户管理网页的 18083。若服务器要求账号或自定义证书，请检查“安全与高级”中的对应设置。", "error") }
    finally { setBusy(false) }
  }
  const hasUnsavedAddress = origin.trim() !== (settings?.backendOrigin ?? "")
  return <>
    <SettingsHeading title="连接" detail="先保存 Banguru 服务器地址，再验证连接。Linkle 的服务器在 Linkle 大厅中选择。" />
    <div className="fluent-settings-group"><div className="fluent-settings-block">
      <Field label="1. Banguru 服务器地址" hint="远程服务器使用 HTTPS；本机服务器可使用 HTTP。" validationState={addressError ? "error" : "none"} validationMessage={addressError}>
        <Input value={origin} placeholder="http://127.0.0.1:18082" disabled={busy || !settings} onChange={event => { setOrigin(event.target.value); setMessage("") }} />
      </Field>
      <Text size={200}>在这台电脑上运行项目时，18082 是 Banguru 后端端口。18083 是用户管理网页，不能填在这里。示例地址不会自动保存。</Text>
      <Text size={200}>更换或清空地址会结束当前 Banguru 房间会话。留空保存会移除服务器地址。</Text>
      <Button appearance="primary" icon={<SaveRegular />} disabled={busy || !settings || Boolean(addressError)} onClick={() => void save()}>保存地址</Button>
    </div><div className="fluent-settings-block">
      <Text weight="semibold">2. 验证连接</Text>
      <Text size={200}>{hasUnsavedAddress ? "地址尚未保存，请先保存再验证。" : settings?.backendOrigin ? `验证目标：${settings.backendOrigin}` : "保存服务器地址后即可验证。"}</Text>
      <Button disabled={busy || !settings?.backendOrigin || hasUnsavedAddress || Boolean(addressError)} onClick={() => void verify()}>验证已保存的连接</Button>
      <Text size={200}>验证只检查服务器访问，不会加入房间。{settings?.backendOrigin ? `当前房间连接：${connectionLabel(state?.connection)}。` : ""}需要站点登录或自定义证书时，请到“安全与高级”。</Text>
    </div></div>
    <StatusMessage message={addressError ?? message} intent={addressError ? "error" : intent} />
  </>
}

function SecurityPanel({ musicPartyOrigin, onLogout }: { musicPartyOrigin: string; onLogout: () => Promise<void> }) {
  const [origin, setOrigin] = useState("")
  const [pem, setPem] = useState("")
  const [records, setRecords] = useState<OriginTrustRecord[]>([])
  const { message, intent, setMessage } = useSettingsMessage()
  const [busy, setBusy] = useState(false)
  useEffect(() => { void listOriginTrust().then(setRecords).catch(() => setMessage("TLS 信任管理暂不可用", "error")) }, [])
  async function run(action: () => Promise<unknown>, ok: string) { setBusy(true); try { await action(); setMessage(ok, "success") } catch (error) { setMessage(errorMessage(error, "该原生能力暂不可用，请更新桌面端后重试"), "error") } finally { setBusy(false) } }
  async function saveTrust() {
    await run(() => importOriginTrust({ origin, pem }).then(record => { setRecords(value => [...value.filter(item => item.origin !== record.origin), record]); setPem("") }), "已保存此服务器的证书信任，请重新尝试连接")
  }
  return <>
    <SettingsHeading title="安全与高级" detail="管理站点登录、自定义证书和 Linkle 登录会话。" />
    <Accordion collapsible multiple>
      <AccordionItem value="credentials"><AccordionHeader>Banguru 站点账号和密码</AccordionHeader><AccordionPanel><CredentialsPanel /></AccordionPanel></AccordionItem>
      <AccordionItem value="linkle"><AccordionHeader>Linkle 登录会话</AccordionHeader><AccordionPanel>
        <div className="fluent-settings-group"><div className="fluent-settings-block">
          <Text size={200}>当前服务器：{musicPartyOrigin}。私密房间的密码在加入房间时输入，无需在设置中预先授权。</Text>
          <Text weight="semibold">注销当前 Linkle 服务器</Text><Text size={200}>结束此服务器上的登录和播放会话。再次加入房间前，需要重新登录。</Text><Button disabled={busy} onClick={() => void run(onLogout, "已从当前 Linkle 服务器注销")}>注销 Linkle</Button></div></div>
      </AccordionPanel></AccordionItem>
      <AccordionItem value="certificates"><AccordionHeader>高级：自定义服务器证书</AccordionHeader><AccordionPanel>
        <Text as="p">大多数服务器无需设置。仅当服务器使用自签名证书或私有证书机构时，向管理员索取证书，并通过可信渠道核对来源后导入。</Text>
        <Text as="p">信任只用于指定的协议、主机和端口，不会信任其他服务器。应用仍会验证 HTTPS 证书和主机名；导入证书不会关闭验证。</Text>
        <div className="fluent-settings-group"><div className="fluent-settings-block">
          <Field label="要信任的服务器地址" hint="填写完整 HTTPS 来源，例如 https://music.example.com:8443，不含页面路径。"><Input value={origin} placeholder="https://music.example.com" disabled={busy} onChange={event => setOrigin(event.target.value)} /></Field>
          <Field label="管理员提供的证书内容（PEM）" hint="粘贴包含 BEGIN CERTIFICATE 和 END CERTIFICATE 的完整证书。不要粘贴私钥。证书由桌面端保存在本机。"><Textarea value={pem} resize="vertical" disabled={busy} onChange={event => setPem(event.target.value)} /></Field>
          <Text size={200}>导入会替换此服务器已有的信任记录。错误的证书可能导致无法连接；未经核实的证书可能让应用信任冒充的服务器。</Text>
          <Button appearance="primary" disabled={busy || !origin || !pem} onClick={() => void saveTrust()}>信任此服务器的证书</Button>
        </div></div>
        <Text as="h2" size={400} weight="semibold">已信任的服务器</Text>
        <Text as="p" size={200}>删除后将恢复默认的证书验证规则，依赖此证书的连接可能失败。</Text>
        {records.map(record => <div className="fluent-settings-trust" key={record.origin}><div><Text weight="semibold">{record.origin}</Text><Text size={200}>证书指纹：{record.fingerprint}</Text></div><Button icon={<DeleteRegular />} appearance="subtle" disabled={busy} aria-label={`删除 ${record.origin} 的证书信任`} onClick={() => void run(() => deleteOriginTrust(record.origin).then(() => setRecords(value => value.filter(item => item.origin !== record.origin))), "已删除此服务器的证书信任")}>删除信任</Button></div>)}
      </AccordionPanel></AccordionItem>
    </Accordion>
    <StatusMessage message={message} intent={intent} />
  </>
}
