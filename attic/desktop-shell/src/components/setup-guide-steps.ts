// Setup Guide（首次使用引导）步骤状态机。
// 纯函数、零依赖，便于 node --test 直接转译运行。
// 步骤定义与跳过语义见 banguru/temp-html/setup-guide-full-flow-mockup.html（形态 A 定稿稿）。

export const SETUP_STEP_ORDER = [
  "banguru-origin",
  "verify",
  "account",
  "linkle-origin",
  "linkle-invite",
] as const

export type SetupStepId = (typeof SETUP_STEP_ORDER)[number]

export type SetupStepAction = "next" | "back" | "goto-linkle"

/** 步骤条标题，与 mockup A1 帧一致。 */
export const SETUP_STEP_LABELS: Record<SetupStepId, string> = {
  "banguru-origin": "Banguru 服务器",
  "verify": "验证连接",
  "account": "账号与昵称",
  "linkle-origin": "Linkle 服务器",
  "linkle-invite": "Linkle 邀请码",
}

export function stepIndex(step: SetupStepId): number {
  return SETUP_STEP_ORDER.indexOf(step)
}

/**
 * 步骤迁移。退出类动作（跳过向导 / 跳过 Banguru 之后完成 / 跳过 Linkle / 完成）
 * 由组件直接调用 services.finish()，不经过本函数；
 * 「跳到 Linkle 配置」是唯一的三步跳跃：banguru-origin → linkle-origin。
 * 非法的 back/next 在边界处返回原步骤（linkle-invite 没有 next，banguru-origin 没有 back）。
 */
export function transition(step: SetupStepId, action: SetupStepAction): SetupStepId {
  switch (step) {
    case "banguru-origin":
      if (action === "next") return "verify"
      if (action === "goto-linkle") return "linkle-origin"
      return step
    case "verify":
      if (action === "back") return "banguru-origin"
      if (action === "next") return "account"
      return step
    case "account":
      if (action === "back") return "verify"
      if (action === "next") return "linkle-origin"
      return step
    case "linkle-origin":
      if (action === "back") return "account"
      if (action === "next") return "linkle-invite"
      return step
    case "linkle-invite":
      if (action === "back") return "linkle-origin"
      return step
  }
}

/** 「跳到 Linkle 配置」时被跨越的步骤，步骤条上以划线态展示。 */
export const BANGURU_PATH_STEPS: readonly SetupStepId[] = ["banguru-origin", "verify", "account"]

const NICKNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * 首次使用生成一个 8 位小写字母数字 ID 作为昵称默认值，避免空白输入框逼用户
 * 先想名字（定稿稿 A3「本机用户」占位方案的替代）。已保存过昵称的 profile 不走
 * 这里；`rng` 可注入以便测试。
 */
export function generateNickname(rng: () => number = Math.random, length = 8): string {
  let out = ""
  for (let index = 0; index < length; index += 1) {
    out += NICKNAME_ALPHABET[Math.floor(rng() * NICKNAME_ALPHABET.length) % NICKNAME_ALPHABET.length]
  }
  return out
}

/** readiness 载荷里本模块只读这些字段；本地化 message 一律不参与判断。 */
export interface ReadinessLineInput {
  status?: string
  code?: string
}

export interface ReadinessLineReport {
  status?: string
  components?: {
    core?: ReadinessLineInput
    openlist?: ReadinessLineInput
    mediaRoots?: ReadinessLineInput
  }
  diagnostics?: { code?: string }[]
}

/**
 * 完成横幅第二行文案。只读 `status`/`code`/`diagnostics[].code`，绝不读本地化
 * `message`（后端交接稿 §6.3）；载荷缺失（老后端没有 readiness 端点，或探针失败拿到
 * null）时返回 `null`，让横幅保持单行 —— 缺信息不等于降级。
 *
 * 注意 Node 侧的真实口径（`server/core/http/readiness.ts:66-79`）：顶层 `status` 是
 * `ready|degraded`，但**组件级** `status` 是 `up|down`；未配置类信息不在
 * `components.openlist.code`（那里只放 `MediaHealthCode`），而在 `diagnostics[]`。
 */
export function readinessSummary(readiness: ReadinessLineReport | null | undefined): string | null {
  const parts = readinessParts(readiness)
  if (!parts.openlist && !parts.roots) return null
  return [parts.openlist, parts.roots].filter(Boolean).join("。")
}

/** 同一份判定拆开给状态卡的两行用（「媒体源」「媒体库」各占一行）。 */
export function readinessParts(readiness: ReadinessLineReport | null | undefined): { openlist: string | null; roots: string | null } {
  if (!readiness) return { openlist: null, roots: null }
  const openlist = readiness.components?.openlist
  const roots = readiness.components?.mediaRoots
  const diagnosticCodes = new Set((readiness.diagnostics ?? []).map(entry => entry.code))
  const unconfigured = diagnosticCodes.has("OPENLIST_URL_NOT_CONFIGURED") || diagnosticCodes.has("OPENLIST_PASSWORD_NOT_CONFIGURED")
  const openlistLabel = !openlist ? null
    : unconfigured ? "媒体源：未配置"
    : openlist.status === "up" ? "媒体源：已就绪"
    : "媒体源：不可用"
  const rootsLabel = !roots ? null
    : roots.status === "up" ? "媒体库：已就绪"
    : (roots.code === "MEDIA_ROOT_NOT_FOUND"
      || (roots as { roots?: { ok?: boolean }[] }).roots?.some(root => root.ok === false)) ? "媒体库：路径未找到"
    : "媒体库：不可用"
  return { openlist: openlistLabel, roots: rootsLabel }
}

/**
 * Linkle（Go 方言）readiness 里本模块只读这些字段 —— 形状由 `shared/musicparty-adapter.ts`
 * 的 `readLinkleReadiness` 摊平，所以这里不重复那套嵌套 wire 形状。
 */
export interface LinkleReadinessLineInput {
  /** `components.neteaseApi.status`：组件级只有 `up|down`，`ready|degraded` 只在顶层。 */
  mediaSource?: string | null
  /** `components.neteaseApi.code`：只可能是传输码（`NETEASE_OK` 等）。 */
  mediaSourceCode?: string | null
  /** `diagnostics[].code`：未配置类码只出现在这里，不在组件码里。 */
  diagnosticCodes?: string[]
}

/**
 * 向导步骤 4 的「媒体源：…」行。只读码，不读本地化 `message`（后端交接稿 §9 不变量 3）。
 * 拿不到载荷（老后端没有 `features.readiness`、非 200、解不出）时返回 `null`，调用方整行不渲染 ——
 * 缺信息不等于降级。
 */
export function linkleReadinessLine(readiness: LinkleReadinessLineInput | null | undefined): string | null {
  if (!readiness) return null
  if (readiness.mediaSource === "up") return "媒体源：已就绪"
  // 未配置的是部署者的 env（NETEASE_API_URL），不是用户填错了地址 —— 文案不能说"请检查你的地址"。
  if ((readiness.diagnosticCodes ?? []).includes("NETEASE_URL_NOT_CONFIGURED")) return "媒体源：服务端未配置"
  const code = readiness.mediaSourceCode
  if (code === "NETEASE_TIMEOUT") return "媒体源：超时"
  if (code === "NETEASE_UNREACHABLE") return "媒体源：不可达"
  if (code === "NETEASE_BAD_RESPONSE") return "媒体源：服务异常"
  return readiness.mediaSource === "down" || code ? "媒体源：不可用" : null
}
