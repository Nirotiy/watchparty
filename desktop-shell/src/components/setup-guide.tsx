import { useCallback, useEffect, useRef, useState } from "react"
import {
  BANGURU_PATH_STEPS,
  SETUP_STEP_LABELS,
  SETUP_STEP_ORDER,
  generateNickname,
  stepIndex,
  transition,
  type SetupStepId,
} from "./setup-guide-steps"

// Setup Guide（首次使用引导）· 形态 A 首屏前置向导。
// 设计定稿：banguru/temp-html/setup-guide-full-flow-mockup.html（§1 步骤定义、§2 A1–A7 帧）。
// 约束：地址一律不预填（端口口径只出现在 placeholder / hint）；凭据不回显；
// 零 index.css 改动（Tailwind + CSS 变量）；本组件自身不新增 IPC——services 由接入方
// （App.tsx）注入既有白名单命令（readiness 探针亦在 App.tsx 侧发起）。
// A7 为演示帧：本组件不改动 Banguru / Linkle 大厅的任何现有布局。

export interface SetupGuideInitial {
  backendOrigin: string | null
  nickname: string
  linkleOrigin: string
  credentialsConfigured: boolean
}

export interface VerifySuccess {
  ok: true
  statusLine: string
  protocolLine: string
  capabilityLine: string
  accountLine: string
}

export interface VerifyFailure {
  ok: false
  message: string
  hint: string
}

export type VerifyOutcome = VerifySuccess | VerifyFailure

export interface SaveResult {
  ok: boolean
  message?: string
}

/**
 * Linkle 地址的验证结果。与 `VerifySuccess` 不同：这里只有一行「媒体源：…」，
 * 而且 `line: null` 是合法成功态（老后端没有 readiness 或探针失败 ⇒ 没有信息，
 * 不是降级）—— 调用方整行不渲染。
 */
export type LinkleVerifyOutcome = { ok: true; line: string | null } | { ok: false; message: string }

/** 全部能力由接入方映射到现有 IPC 白名单命令；组件本身不 import lib/ipc。 */
export interface SetupGuideServices {
  loadInitial(): Promise<SetupGuideInitial>
  saveBanguruOrigin(origin: string): Promise<SaveResult>
  verifyBanguru(): Promise<VerifyOutcome>
  /** 探测 Linkle 服务并给出「媒体源：…」一行（可选面，缺信息时 line 为 null）。 */
  verifyLinkle(origin: string): Promise<LinkleVerifyOutcome>
  promptSiteCredentials(): Promise<boolean>
  saveNickname(nickname: string): Promise<SaveResult>
  saveLinkleOrigin(origin: string): Promise<SaveResult>
  redeemLinkleInvite(code: string): Promise<{ ok: true; accountName: string } | { ok: false; message: string }>
  /** 写完成位（setupCompleted=true）并落当前已保存的值；任何跳过路径最终都走这里。 */
  finish(setup: { backendOrigin: string | null; nickname: string }): Promise<SaveResult>
}

export interface SetupGuideProps {
  services: SetupGuideServices
  onDone(): void
  /** 测试注入：跳过重挂载后的 loadInitial，直接以给定值起步。 */
  seed?: Partial<SetupGuideInitial>
}

type VerifyPhase = { kind: "idle" } | { kind: "running" } | { kind: "done"; outcome: VerifyOutcome }

type LinkleVerifyPhase = { kind: "idle" } | { kind: "running" } | { kind: "done"; outcome: LinkleVerifyOutcome }

type RedeemPhase = { kind: "idle" } | { kind: "running" } | { kind: "done"; accountName: string } | { kind: "error"; message: string }

const BTN_PRIMARY = "rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[#0b1b29] disabled:opacity-40"
const BTN_DEFAULT = "rounded border border-[var(--stroke-divider)] bg-[var(--fill-card)] px-4 py-1.5 text-sm disabled:opacity-40"
const BTN_GHOST = "px-3 py-1.5 text-sm text-[var(--accent)] disabled:opacity-40"
const INPUT = "h-8 w-full rounded border border-[var(--stroke-divider)] border-b-[#8a929c] bg-[rgba(255,255,255,0.03)] px-2 py-1 text-sm focus:border-b-[var(--accent)] focus:outline-none disabled:opacity-50"
const LABEL = "mb-1.5 block text-xs text-[var(--text-secondary)]"
const HINT = "mt-1.5 text-[11px] text-[var(--text-disabled)]"

function messageBar(kind: "ok" | "err" | "warn", body: React.ReactNode) {
  const border = kind === "ok" ? "#5dd39e" : kind === "err" ? "#ff7b72" : "#e0b25c"
  return (
    <div role="status" className="my-3 flex gap-2.5 rounded border border-[var(--stroke-card)] bg-[var(--fill-card)] px-3 py-2.5 text-xs" style={{ borderLeft: `3px solid ${border}` }}>
      {body}
    </div>
  )
}

export function SetupGuide({ services, onDone, seed }: SetupGuideProps) {
  const [step, setStep] = useState<SetupStepId>("banguru-origin")
  const [skippedBanguruPath, setSkippedBanguruPath] = useState(false)
  const [origin, setOrigin] = useState("")
  const [nickname, setNickname] = useState("")
  const [linkleOrigin, setLinkleOrigin] = useState("")
  const [credentialsConfigured, setCredentialsConfigured] = useState(false)
  const [originError, setOriginError] = useState<string | null>(null)
  const [linkleOriginError, setLinkleOriginError] = useState<string | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const initialized = useRef(false)

  // 只初始化一次：即使接入方每次渲染传入新的 services / seed 引用，也不会冲掉用户已输入的内容。
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (seed) {
      setOrigin(seed.backendOrigin ?? "")
      setNickname(seed.nickname ?? generateNickname())
      setLinkleOrigin(seed.linkleOrigin ?? "")
      setCredentialsConfigured(seed.credentialsConfigured ?? false)
      return
    }
    let disposed = false
    void services.loadInitial().then((initial) => {
      if (disposed) return
      setOrigin(initial.backendOrigin ?? "")
      // 已保存过昵称就回显；全新 profile 给一个 8 位随机 ID，不再给空框。
      setNickname(initial.nickname?.trim() ? initial.nickname : generateNickname())
      setLinkleOrigin(initial.linkleOrigin)
      setCredentialsConfigured(initial.credentialsConfigured)
    }).catch(() => { /* 保持空值起步，各步骤允许用户自行填写 */ })
    return () => { disposed = true }
  }, [services, seed])
  const [verify, setVerify] = useState<VerifyPhase>({ kind: "idle" })

  const runVerify = useCallback(() => {
    setVerify({ kind: "running" })
    void services.verifyBanguru().then((outcome) => {
      setVerify({ kind: "done", outcome })
    }).catch((failure: unknown) => {
      setVerify({ kind: "done", outcome: { ok: false, message: "无法完成验证，请稍后重试。", hint: failure instanceof Error ? failure.message : "" } })
    })
  }, [services])

  useEffect(() => {
    if (step === "verify" && verify.kind === "idle") runVerify()
  }, [step, verify.kind, runVerify])

  const [linkleVerify, setLinkleVerify] = useState<LinkleVerifyPhase>({ kind: "idle" })

  // 用户点「验证媒体源」才探测：Linkle 是可跳过的可选路径，进步骤 4 就自动打网络对
  // 从不用的用户是白花的往返；地址一改就作废上一次结果，避免把旧地址的结论显示在新地址下。
  const runLinkleVerify = useCallback(() => {
    const target = linkleOrigin.trim()
    if (!target) return
    setLinkleVerify({ kind: "running" })
    void services.verifyLinkle(target).then((outcome) => {
      setLinkleVerify({ kind: "done", outcome })
    }).catch(() => {
      setLinkleVerify({ kind: "done", outcome: { ok: false, message: "无法完成验证，请稍后重试。" } })
    })
  }, [services, linkleOrigin])

  const finish = useCallback(async (finalOrigin: string | null, finalNickname: string) => {
    setBusy(true)
    setFinishError(null)
    try {
      const result = await services.finish({ backendOrigin: finalOrigin, nickname: finalNickname })
      if (result.ok) { onDone(); return }
      setFinishError(result.message ?? "保存完成状态失败，请重试。")
    } catch (failure) {
      setFinishError(failure instanceof Error ? failure.message : "保存完成状态失败，请重试。")
    } finally {
      setBusy(false)
    }
  }, [services, onDone])

  const submitOrigin = async () => {
    if (!origin.trim()) return
    setBusy(true)
    setOriginError(null)
    try {
      const result = await services.saveBanguruOrigin(origin.trim())
      if (!result.ok) { setOriginError(result.message ?? "地址保存失败，请检查格式。"); return }
      setStep((current) => transition(current, "next"))
    } finally {
      setBusy(false)
    }
  }

  const submitAccount = async () => {
    if (!nickname.trim()) return
    setBusy(true)
    try {
      const result = await services.saveNickname(nickname.trim())
      if (result.ok) setStep((current) => transition(current, "next"))
    } finally {
      setBusy(false)
    }
  }

  const submitLinkleOrigin = async () => {
    if (!linkleOrigin.trim()) return
    setBusy(true)
    setLinkleOriginError(null)
    try {
      const result = await services.saveLinkleOrigin(linkleOrigin.trim())
      if (!result.ok) { setLinkleOriginError(result.message ?? "地址保存失败，请检查格式。"); return }
      setStep((current) => transition(current, "next"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="首次使用设置向导" className="mx-auto min-h-full w-full max-w-[720px] px-8 py-8">
      <StepRail step={step} skippedBanguruPath={skippedBanguruPath} />
      {step === "banguru-origin" ? (
        <BanguruOriginPanel
          origin={origin}
          error={originError}
          busy={busy}
          onOriginChange={(value) => { setOrigin(value); setOriginError(null) }}
          onNext={() => void submitOrigin()}
          onSkipWizard={() => void finish(null, nickname)}
          onSkipBanguru={() => { setSkippedBanguruPath(true); setStep((current) => transition(current, "goto-linkle")) }}
        />
      ) : null}
      {step === "verify" ? (
        <VerifyPanel
          origin={origin}
          verify={verify}
          onBack={() => { setVerify({ kind: "idle" }); setStep((current) => transition(current, "back")) }}
          onRetry={runVerify}
          onContinue={() => setStep((current) => transition(current, "next"))}
        />
      ) : null}
      {step === "account" ? (
        <AccountPanel
          credentialsConfigured={credentialsConfigured}
          nickname={nickname}
          busy={busy}
          onPromptCredentials={() => {
            void services.promptSiteCredentials().then((saved) => {
              if (saved) setCredentialsConfigured(true)
            }).catch(() => { /* 凭据对话框取消或失败：保持未设置 */ })
          }}
          onNicknameChange={setNickname}
          onBack={() => setStep((current) => transition(current, "back"))}
          onNext={() => void submitAccount()}
        />
      ) : null}
      {step === "linkle-origin" ? (
        <LinkleOriginPanel
          linkleOrigin={linkleOrigin}
          error={linkleOriginError}
          busy={busy}
          verify={linkleVerify}
          onVerify={runLinkleVerify}
          onLinkleOriginChange={(value) => { setLinkleOrigin(value); setLinkleOriginError(null); setLinkleVerify({ kind: "idle" }) }}
          onBack={() => { setSkippedBanguruPath(false); setStep((current) => transition(current, "back")) }}
          onSkipLinkle={() => void finish(skippedBanguruPath ? null : origin, nickname)}
          onNext={() => void submitLinkleOrigin()}
        />
      ) : null}
      {step === "linkle-invite" ? (
        <LinkleInvitePanel
          linkleOrigin={linkleOrigin}
          busy={busy}
          finishError={finishError}
          onBack={() => setStep((current) => transition(current, "back"))}
          onSkip={() => void finish(origin, nickname)}
          onFinish={() => void finish(origin, nickname)}
          redeem={(code) => services.redeemLinkleInvite(code)}
        />
      ) : null}
    </section>
  )
}

function StepRail({ step, skippedBanguruPath }: { step: SetupStepId; skippedBanguruPath: boolean }) {
  return (
    <ol aria-label="设置进度" className="mb-5 flex flex-wrap gap-0.5">
      {SETUP_STEP_ORDER.map((id) => {
        const index = stepIndex(id)
        const current = stepIndex(step)
        const skipped = skippedBanguruPath && BANGURU_PATH_STEPS.includes(id)
        const className = skipped
          ? "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--text-disabled)] line-through"
          : index < current
            ? "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[#5dd39e]"
            : id === step
              ? "flex items-center gap-1.5 rounded bg-[var(--fill-selected)] px-2 py-1 text-[11px] text-[var(--accent)]"
              : "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--text-disabled)]"
        return (
          <li key={id} aria-current={id === step ? "step" : undefined} className={className}>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-semibold">
              {index < current && !skipped ? "✓" : index + 1}
            </span>
            {SETUP_STEP_LABELS[id]}
          </li>
        )
      })}
    </ol>
  )
}

export interface BanguruOriginPanelProps {
  origin: string
  error: string | null
  busy: boolean
  onOriginChange(value: string): void
  onNext(): void
  onSkipWizard(): void
  onSkipBanguru(): void
}

export function BanguruOriginPanel({ origin, error, busy, onOriginChange, onNext, onSkipWizard, onSkipBanguru }: BanguruOriginPanelProps) {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">欢迎使用 Banguru</h1>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">首次使用需要完成一次连接设置（约 2 分钟）。所有内容只保存在本机，之后长期静默复用。</p>
      <div className="my-3">
        <label className={LABEL} htmlFor="setup-banguru-origin">Banguru 服务器地址</label>
        <input
          id="setup-banguru-origin"
          className={INPUT}
          value={origin}
          onChange={(event) => onOriginChange(event.target.value)}
          placeholder="http://主机:8080"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        {error ? <p role="alert" className="mt-1.5 text-[11px] text-[#ff9d96]">{error}</p> : null}
        <p className={HINT}>Banguru 后端默认监听 8080；把「主机」换成你部署服务器的地址。远程服务器请用 HTTPS；「允许远程 HTTP」开关只影响 Banguru 侧。</p>
      </div>
      <p>
        <button type="button" className={BTN_GHOST} onClick={onSkipBanguru} disabled={busy}>还没有 Banguru 服务器？跳到 Linkle 配置 →</button>
      </p>
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={BTN_GHOST} onClick={onSkipWizard} disabled={busy}>跳过向导</button>
        <button type="button" className={BTN_PRIMARY} onClick={onNext} disabled={busy || !origin.trim()}>下一步：验证连接</button>
      </div>
    </div>
  )
}

export interface VerifyPanelProps {
  origin: string
  verify: VerifyPhase
  onBack(): void
  onRetry(): void
  onContinue(): void
}

export function VerifyPanel({ origin, verify, onBack, onRetry, onContinue }: VerifyPanelProps) {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">验证连接</h1>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">目标：{origin} · 验证只检查服务器访问，不会加入房间。</p>
      {verify.kind === "running" || verify.kind === "idle" ? (
        <p role="status" className="my-3 text-xs text-[var(--text-secondary)]">正在验证…</p>
      ) : verify.outcome.ok ? (
        <>
          <dl className="my-3 grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-[var(--text-secondary)]">状态</dt><dd className="font-semibold">{verify.outcome.statusLine}</dd>
            <dt className="text-[var(--text-secondary)]">协议</dt><dd className="font-semibold">{verify.outcome.protocolLine}</dd>
            <dt className="text-[var(--text-secondary)]">能力</dt><dd className="font-semibold">{verify.outcome.capabilityLine}</dd>
            <dt className="text-[var(--text-secondary)]">站点账号</dt><dd className="font-semibold">{verify.outcome.accountLine}</dd>
          </dl>
          {messageBar("ok", <div>服务器连接正常。<span className="mt-0.5 block text-[var(--text-secondary)]">服务器若要求账号密码，可在下一步或「设置 → 安全与高级」补设。</span></div>)}
        </>
      ) : (
        <>
          {messageBar("err", <div>{verify.outcome.message}<span className="mt-0.5 block text-[var(--text-secondary)]">{verify.outcome.hint}</span></div>)}
          <p className="my-3 text-xs text-[var(--text-secondary)]">可以修正地址后重试，或保存并继续——之后随时在「设置 → 连接」重新配置。</p>
        </>
      )}
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={BTN_GHOST} onClick={onBack}>上一步</button>
        <span className="flex gap-2">
          <button type="button" className={BTN_DEFAULT} onClick={onRetry} disabled={verify.kind === "running" || verify.kind === "idle"}>重试验证</button>
          <button type="button" className={BTN_PRIMARY} onClick={onContinue}>保存并继续</button>
        </span>
      </div>
    </div>
  )
}

export interface AccountPanelProps {
  credentialsConfigured: boolean
  nickname: string
  busy: boolean
  onPromptCredentials(): void
  onNicknameChange(value: string): void
  onBack(): void
  onNext(): void
}

export function AccountPanel({ credentialsConfigured, nickname, busy, onPromptCredentials, onNicknameChange, onBack, onNext }: AccountPanelProps) {
  const [credentialsDismissed, setCredentialsDismissed] = useState(false)
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">账号与昵称</h1>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">站点账号仅在你的服务器要求 Basic Auth 时设置；密码保存在 Windows 凭据管理器，界面无法读回。</p>
      <div className="mb-2 flex items-center justify-between gap-2.5 rounded border border-[var(--stroke-card)] bg-[var(--fill-card)] px-3 py-2.5 text-sm">
        <div>
          <strong className="text-sm">站点登录（Basic Auth）</strong>
          <span className="block text-[11px] text-[var(--text-secondary)]">{credentialsConfigured ? "已保存账号和密码" : "未设置 · 与房间 PIN 不同"}</span>
        </div>
        {credentialsConfigured || credentialsDismissed ? (
          <span className="text-xs text-[var(--text-secondary)]">可稍后在「设置 → 安全与高级」修改</span>
        ) : (
          <span className="flex gap-1">
            <button type="button" className={BTN_DEFAULT} onClick={onPromptCredentials} disabled={busy}>设置账号和密码</button>
            <button type="button" className={BTN_GHOST} onClick={() => setCredentialsDismissed(true)} disabled={busy}>跳过</button>
          </span>
        )}
      </div>
      <div className="my-3">
        <label className={LABEL} htmlFor="setup-nickname">昵称</label>
        <input
          id="setup-nickname"
          className={INPUT}
          value={nickname}
          onChange={(event) => onNicknameChange(event.target.value)}
          placeholder="显示给房间成员"
          disabled={busy}
        />
        <p className={HINT}>显示给房间成员；保存进本机设置，之后可在设置中修改。</p>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={BTN_GHOST} onClick={onBack} disabled={busy}>上一步</button>
        <button type="button" className={BTN_PRIMARY} onClick={onNext} disabled={busy || !nickname.trim()}>下一步：Linkle 服务器</button>
      </div>
    </div>
  )
}

export interface LinkleOriginPanelProps {
  linkleOrigin: string
  error: string | null
  busy: boolean
  verify: LinkleVerifyPhase
  onVerify(): void
  onLinkleOriginChange(value: string): void
  onBack(): void
  onSkipLinkle(): void
  onNext(): void
}

export function LinkleOriginPanel({ linkleOrigin, error, busy, verify, onVerify, onLinkleOriginChange, onBack, onSkipLinkle, onNext }: LinkleOriginPanelProps) {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Linkle（一起听）</h1>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">Linkle 是可选的第二服务。没有 Linkle 服务器可整体跳过，之后随时在 Linkle 大厅补配。</p>
      <div className="my-3">
        <label className={LABEL} htmlFor="setup-linkle-origin">Linkle 服务器地址</label>
        <input
          id="setup-linkle-origin"
          className={INPUT}
          value={linkleOrigin}
          onChange={(event) => onLinkleOriginChange(event.target.value)}
          placeholder="https://music.example.com"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        {error ? <p role="alert" className="mt-1.5 text-[11px] text-[#ff9d96]">{error}</p> : null}
        {verify.kind === "running" ? <p role="status" className="mt-1.5 text-[11px] text-[var(--text-secondary)]">正在验证媒体源…</p> : null}
        {verify.kind === "done" && verify.outcome.ok && verify.outcome.line ? <p role="status" className="mt-1.5 text-[11px] text-[var(--text-secondary)]">{verify.outcome.line}</p> : null}
        {verify.kind === "done" && !verify.outcome.ok ? <p role="alert" className="mt-1.5 text-[11px] text-[#ff9d96]">{verify.outcome.message}</p> : null}
        <p className={HINT}>本地调试栈地址为 http://127.0.0.1:18380；远程服务器请用 HTTPS——Linkle 侧不允许非回环 HTTP（与 Banguru 策略不同）。</p>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={BTN_GHOST} onClick={onSkipLinkle} disabled={busy}>跳过 Linkle</button>
        <span className="flex gap-2">
          <button type="button" className={BTN_DEFAULT} onClick={onVerify} disabled={busy || verify.kind === "running" || !linkleOrigin.trim()}>{verify.kind === "done" ? "重新验证" : "验证媒体源"}</button>
          <button type="button" className={BTN_DEFAULT} onClick={onBack} disabled={busy}>上一步</button>
          <button type="button" className={BTN_PRIMARY} onClick={onNext} disabled={busy || !linkleOrigin.trim()}>保存并继续</button>
        </span>
      </div>
    </div>
  )
}

export interface LinkleInvitePanelProps {
  linkleOrigin: string
  busy: boolean
  finishError: string | null
  onBack(): void
  onSkip(): void
  onFinish(): void
  redeem(code: string): Promise<{ ok: true; accountName: string } | { ok: false; message: string }>
}

export function LinkleInvitePanel({ linkleOrigin, busy, finishError, onBack, onSkip, onFinish, redeem }: LinkleInvitePanelProps) {
  const [inviteCode, setInviteCode] = useState("")
  const [redeemState, setRedeemState] = useState<RedeemPhase>({ kind: "idle" })
  const submitRedeem = () => {
    const code = inviteCode.trim()
    if (!code || redeemState.kind === "running") return
    setInviteCode("")
    setRedeemState({ kind: "running" })
    void redeem(code).then((result) => {
      if (result.ok) setRedeemState({ kind: "done", accountName: result.accountName })
      else setRedeemState({ kind: "error", message: result.message })
    }).catch(() => setRedeemState({ kind: "error", message: "兑换失败，请检查邀请码后重试。" }))
  }
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">邀请码（可选）</h1>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">邀请码用于换取 Linkle 登录会话——加入或创建房间需要会话，仅浏览房间列表不需要。没有邀请码就先跳过，之后随时在 Linkle 大厅「有邀请码？」处兑换。</p>
      <div className="my-3">
        <label className={LABEL} htmlFor="setup-invite-code">邀请码</label>
        <span className="flex gap-2">
          <input
            id="setup-invite-code"
            type="password"
            className={INPUT}
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="粘贴一次性邀请码"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <button type="button" className={BTN_DEFAULT} onClick={submitRedeem} disabled={busy || !inviteCode.trim() || redeemState.kind === "running"}>兑换</button>
        </span>
        <p className={HINT}>服务器：{linkleOrigin}。一次性邀请码只用于换取登录会话，不会被保存、显示或写入日志。</p>
        {redeemState.kind === "running" ? <p role="status" className="mt-1.5 text-[11px] text-[var(--text-secondary)]">正在兑换…</p> : null}
        {redeemState.kind === "done" ? <p role="status" className="mt-1.5 text-[11px] text-[#5dd39e]">当前账号：{redeemState.accountName} · 兑换成功，可直接加入房间</p> : null}
        {redeemState.kind === "error" ? <p role="alert" className="mt-1.5 text-[11px] text-[#ff9d96]">{redeemState.message}</p> : null}
      </div>
      {finishError ? messageBar("err", <div>{finishError}</div>) : null}
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={BTN_GHOST} onClick={onSkip} disabled={busy}>跳过，稍后在 Linkle 大厅兑换</button>
        <span className="flex gap-2">
          <button type="button" className={BTN_DEFAULT} onClick={onBack} disabled={busy}>上一步</button>
          <button type="button" className={BTN_PRIMARY} onClick={onFinish} disabled={busy}>完成</button>
        </span>
      </div>
    </div>
  )
}
