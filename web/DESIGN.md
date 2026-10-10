---
version: 1.0 · 2026-10-08
name: banguru-web-tool
status: 已实施并验收（B 墙优先；证据见 §10 实施记录）
description: |
  Banguru Web 工具面的设计系统。双基底：播放器为 #000 影院面（冻结，附录 A）；
  大厅、门禁、媒体库、弹窗等工具面采用近黑四级表面阶梯与 hairline 边框体系。
  审美基线：Raycast DESIGN.md（getdesign.md/raycast/design-md）。
  两处有意偏离：字体改用 Geist（替代 Inter+ss03）；正文字号 14（替代营销站的 16），密度优先。
  治理范围：web/ 的 大厅 / 建房 / 门禁 / 媒体库 / 播放清单 / 成员 / 桌面交接。
  不在范围：播放器（冻结）、媒体源管理、桌面壳、冻结 POC（草稿编辑页已于 2026-10-08 下线，见正文 §8）。
colors:
  canvas: "#07080a"
  surface: "#0d0d0d"
  surface-elevated: "#101111"
  surface-card: "#121212"
  hairline: "#242728"
  hairline-soft: "rgba(255,255,255,0.08)"
  hairline-strong: "rgba(255,255,255,0.16)"
  ink: "#f4f4f6"
  body: "#cdcdcd"
  mute: "#9c9c9d"
  ash: "#6a6b6c"
  stone: "#434345"
  primary: "#ffffff"
  primary-pressed: "#e8e8e8"
  on-primary: "#000000"
  accent-blue: "#57c1ff"
  accent-blue-soft: "rgba(87,193,255,0.15)"
  accent-red: "#ff6161"
  accent-red-soft: "rgba(255,97,97,0.15)"
  accent-green: "#59d499"
  accent-green-soft: "rgba(89,212,153,0.15)"
  accent-yellow: "#ffc533"
  accent-yellow-soft: "rgba(255,197,51,0.15)"
  key-bg-start: "#121212"
  key-bg-end: "#0d0d0d"
typography:
  latin: Geist Sans（数字与拉丁；Geist Mono 用于房号、计数等 mono 场景）
  cjk: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans JP", sans-serif'
  heading-lg: { size: 20px, weight: 500, lineHeight: 1.4 }
  heading: { size: 18px, weight: 500, lineHeight: 1.4 }
  body: { size: 14px, weight: 400, lineHeight: 1.6 }
  body-strong: { size: 14px, weight: 500, lineHeight: 1.6 }
  secondary: { size: 13px, weight: 400, lineHeight: 1.5 }
  caption: { size: 12px, weight: 400, lineHeight: 1.5 }
  mono: { size: 13px, weight: 400 }
  floor: 12px（任何界面文本不得低于此值；禁止 9–11px）
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 16px
  full: 9999px
spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
---

# Banguru Web · 工具面设计系统（DESIGN.md）

本文件是 web/ 工具面 UI 的唯一契约。任何 agent 做界面改动前先读它；与旧实现冲突处，以本文为准。
本文的排版与组织对齐 getdesign.md 的 DESIGN.md 格式（给 AI agent 读的规格，而非给人读的规范书）。

## §1 双基底与来源

- **工具面（本文治理）**：canvas `#07080a` → surface `#0d0d0d` → surface-elevated `#101111` → surface-card `#121212` 四级阶梯；一切层级用阶梯与 1px hairline（`#242728`）表达，**全局零阴影**。
- **影院面（播放器，冻结）**：`#000` 纯黑舞台、既有浮层与控制栏，登记于附录 A，只读。
- **来源**：Raycast 设计文档（`https://getdesign.md/raycast/design-md`，源仓库 VoltAgent/awesome-design-md）。只借视觉语言与克制原则，不搬营销版式（96px 分节、红色斜条纹 hero 等一律不采用）。
- **有意偏离**（用户裁决，勿"纠正"回 Raycast）：
  1. 拉丁/数字字体用 **Geist**（next/font 自托管），不用 Inter+ss03。
  2. 正文 **14px**（Raycast 营销站是 16px）；密度优先，病根是级差不是字号。
  3. CJK 走 Sarasa/Noto Sans SC 回退栈（Noto SC 由 next/font 自托管，见 `app/layout.tsx` 的 `--font-sans` 定义）。

## §2 颜色用法规则

- **主题模式**（2026-10-08 裁决）：两态手动（亮/暗按钮，存本机 `watchparty_theme`），首访跟随系统一次，之后以手动为准；**播放器面恒黑**——房间 ready 时在 `html` 上钉 `.dark`（弹窗 portal 到 body 也覆盖），离开房间恢复用户主题。
- **浅色＝"光 B"阶梯**（`:root`，微灰画布＋白卡浮起）：canvas `#f3f4f5` → surface/card `#ffffff` → elevated `#ececee`；hairline `#e2e3e5`；表单域 `field #ffffff`（浅色下"白域浮在微灰画布上"）；主行动**反转为黑底白字**（`#101112`）；语义色压深（info `#0778b6` / warn `#a86a00` / ok `#178a58` / danger `#cf2e2e`）；弹窗遮罩 `bg-black/45`。
- **深色＝原 Raycast 阶梯**（`.dark`，canvas `#07080a` → …→ card `#121212`；hairline `#242728`）；影院面 `#000` 只读登记于附录 A。两级阶梯以外的色值一律走 token，禁止组件内写死。
- **主行动＝每屏至多一颗实心按钮**：深色＝白底黑字，浅色＝黑底白字；其余行动一律次级/三级。
- **选中态＝阶梯背景（深色 card / 浅色 elevated）+ 前景提亮**；**不**用彩色描边或彩色底。
- **焦点态＝边框提亮为 hairline-strong**；禁止彩色 focus ring（旧实现里的 `focus:border-sky-500` 系列全部作废）。
- **饱和色只做语义**，且只出现在徽标/状态点/键帽提示的极少量场景（两主题同一用法，浅色取压深值）：
  - `warn`：待确认 / 警告（承接现在的候选态 amber）。
  - `danger`：错误 / 危险 / 已拒绝。
  - `ok`：成功 / 已连接 / 运行中。
  - `info`：信息类徽标（如 "MKV maybe"、桌面端提示）。
- 文本四级：`ink`（标题）→ `body`（正文）→ `mute`（次级）→ `ash`（禁用）。禁止再引入第五种灰。
- 海报卡年份/状态角标恒为黑底白字（叠在图上，不随主题）；链接：正文内链用前景色，hover 下划线；不用蓝色链接色。

## §3 字体与刻度

- 拉丁/数字：**Geist Sans**；房号、计数、时间等 mono 场景：**Geist Mono**（tabular）。
- 中文/日文：现有 `--font-sans` 回退栈（Sarasa Gothic 系列 → Noto Sans SC 自托管 → 系统 sans），实施时沿用，勿另起字体方案。
- 刻度（硬约束）：
  | 层级 | 字号/字重 | 用途 |
  |---|---|---|
  | heading-lg | 20 / 500 | 页面级标题（媒体库整页头等）|
  | heading | 18 / 500 | 区块标题、弹窗标题 |
  | body | 14 / 400 | 默认正文、列表主行 |
  | body-strong | 14 / 500 | 强调、当前项 |
  | secondary | 13 / 400 | 元数据、次级行 |
  | caption | 12 / 400 | 徽标、键帽、最小工具文本 |
  | mono | 13 | 房号、ID、计数（Geist Mono）|
- **下限 12px**：现有实现里全部 9/10/11px 文本必须归并到 12 或删除。
- 级差靠字号/字重与留白，不靠颜色深浅；中文 letter-spacing 保持 0。

## §4 间距与圆角

- 间距基数 8：2/4/8/12/16/24/32；卡片内边距 16–24；列表行内边距 6–10。
- 圆角：keycap/徽标 4 · 行 6 · 按钮/输入 8 · 卡片/弹窗 10 · 大容器 16 · 分段胶囊 full。
- 胶囊（`full`）**仅**用于分段控件（视图切换、库切换、筛选）；禁止装饰性胶囊。

## §5 组件规格

- **button-primary**：白底黑字，14/500，高 32–36，radius 8，padding 8×14。pressed 用 `primary-pressed`。
- **button-secondary**：透明底白字（hairline 描边可选）；**button-tertiary**：`surface-elevated` 底白字；**button-ghost**：图标按钮，hover 加 `surface-card` 底。
- **button-destructive**：`accent-red-soft` 底 + `accent-red` 字；disabled：`surface-elevated` 底 + `ash` 字。
- **text-input / search**：`surface-elevated` 底、hairline 描边、radius 8、高 32–36；聚焦只是描边变 `hairline-strong`；搜索变体高 40。
- **keycap**：`surface-card` 底（key-bg 渐变可留）、caption 12、高 20、radius 4；用于一切快捷键提示。
- **badge**：neutral＝surface-elevated 底 + `on-dark-mute` 字；语义四种＝对应 `*-soft` 底 + accent 字；radius 4（**不用 full**）；padding 2×6。
- **row / row-active**：透明底 → 选中 `surface-card`；radius 6；含：图标/缩略图 + 主文本(body-strong) + 右侧元数据(secondary/mono) + 右侧键帽。
- **poster-card**（标题墙，保留项）：海报/兜底图 + 左上角年份、右上角状态徽标（沿用现职权含义）；无阴影、hairline 描边、radius 10；网格间距 16。
- **card**：`surface` 底 + hairline，radius 10，padding 16–24。**禁止**灰度边框 + 内外双 padding 的"两件套"。
- **dialog**：`surface` 底 + hairline + radius 10 + 遮罩 `rgba(0,0,0,0.7)`；无阴影；打开时焦点入弹窗，Esc 关闭。
- **segmented（pill-tabs）**：默认透明 + `body` 字；激活 `surface-elevated` + 白字；radius full；padding 4×10。
- **status-line / toast**：单行、hairline 分隔、左侧状态点；操作结果一律行内就地反馈（与 G 轮接口对接），**不用**解释句。

## §6 键盘与焦点

- 覆盖范围：大厅 + 媒体库 + 弹窗（播放器键盘层见 §10 V2）。
- 地图（首版）：`Esc` 关最上层 · `↑↓` 列表导航 · `⏎` 主行动 · `Tab/⇧Tab` 切换视图与字段 · `⌥⏎` 入队（媒体库行）· `⌘V`/直接粘贴触发"直链识别" · `?` 打开键盘速查面板。
- 提示策略：键帽**悬停/聚焦时显形**（默认不占视觉位），`?` 面板汇总全图；帮助面板本身也是 row 列表 + 键帽。
- 焦点规则：焦点环＝hairline-strong 边框提亮；Tab 顺序按视觉顺序；弹窗关闭后焦点回到触发元素。

## §7 屏幕规格（分层表＝已裁决）

| 面 | 结构 | 删除 / 降级 |
|---|---|---|
| 大厅 | 顶行 wordmark ＋ `?` 速查 ＋ 创建房间（次级）＋ 输入行（房号/邀请 URL，autofocus，行尾「浏览片源」主动作）＋ 继续观看（行式：缩略图＋细进度条＋百分比，本机数据）＋ 最近访问（↑↓⏎，可删单条）＋ 页脚状态行（点＋文字） | 删营销标题与副标题、删居中欢迎卡、"OR"分隔 |
| 建房 | 单列表单（昵称 / PIN / 初始媒体），⏎ 提交 Esc 关闭 | 删所有字段下解释小字 |
| 门禁 | 裸状态行（连接中 / 404 / 错误）＋ PIN 四格输入，不套卡片 | 删卡片壳与说明段 |
| 媒体库 | 顶行搜索（autofocus）＋ 视图分段（标题/文件）＋结果呈现（见 §10 待选）＋整页/弹窗双壳（裁决②保留） | 直链面板降级为"搜索框粘贴识别 ＋ ＋直链 行"；面包屑改轻量路径；删各类指引句 |
| 播放清单 | 行 + `⏎` 播放 / `⌫` 移除 / `⌥↑↓` 移序；成功就地反馈 | 删说明小字 |
| 成员 | 行 + 角色标记；移交就地确认（不嵌第二层卡） | 删第二层说明段 |
| 交接码 | 三态最小化（签发中/就绪/过期）；码以 mono 呈现、`⏎` 复制 | 保留状态机与凭证文案原样，不加装饰 |

保留清单（不得顺手中删）：标题墙海报网格与状态角标、无海报 tinted 首字兜底、Titles/Files 双视图、房号 mono 排版。

## §8 冻结与边界

- **冻结条款**：播放器（舞台 #000、顶/底浮层、控制栏、播放器内菜单）为 cinema 面，任何 agent 不得顺手改其色/字/尺寸；其现存 token 登记于附录 A。
- **草稿编辑/审批界面与刮削入口已下线**（2026-10-08 用户裁决：片源管理交由 MCP 与 agent 处理；`CatalogDraft`、`ApprovalSecretSetting` 组件已删除，"更新标题库"按钮与刮削状态行一并移除，媒体库只保留 标题/文件 两视图）。后端管理路由、`lib/api.ts` 的草稿/刮削客户端函数与 `catalog-view.ts` 的 `scrapeSummary` 暂留，待路由级退役另行裁决。
- 不在本轮：媒体源管理、桌面壳、冻结 POC。网页端不新引入媒体源管理能力。
- 依赖约束：媒体库与弹窗的一切状态语义仍以服务端快照/revision 为权威；缓冲/音量/音轨/字幕是本机状态（沿用既有分工）。

## §9 禁区（Do not）

1. 不在控件/区块下加浅灰解释小字（"……点击此处……""……不受影响"这类句子）；用结构、键帽、状态点表达。
2. 不用灰度 1px 边框卡 + 内外双 padding 的卡片；不用居中标题 + 居中表单的欢迎卡。
3. 不用任何阴影（含 `shadow-2xl` 类）；层级只用表面阶梯与 hairline。
4. 不用小于 12px 的文本；不用 9–11px 徽标。
5. 不用彩色 focus ring；不用饱和色做 chrome（按钮/正文/边框）。
6. 浅色主题＝§2 的"光 B"阶梯（2026-10-08 起取代"不做浅色"）；浅色下不改 12px 下限、不改 hairline 体系、不把语义色当 chrome、播放器面恒黑。
7. 文案：短句、陈述式；不用英文长破折号；不写"请尽量"式客套。

## §10 已裁决与 V2 候选

- **媒体库布局＝B 墙优先**（2026-10-08 选定）：标题墙 5 列海报网格 + 右详情栏；搜索行常驻、搜索优先（autofocus、输入即过滤、去掉提交按钮）；空态下标题墙即默认视图，切换文件视图走分段控件/快捷键；直链粘贴识别为搜索框内联动作（播放 `⏎` / 入队 `⌥⏎`）；命中时墙自动过滤。
- V2 候选（未授权）：播放器键盘层（空格/←→/F/M 等）；播放器视觉微调（用户后续可能放行）。
- 实施与验收挂钩：改动涉及既有验收 helper 时保留其选择器约定（`canvas[aria-label="MKV 视频"]`、播放/暂停/静音按键 aria 标签等）；新增可交互元素需带 aria-label。
- 实施记录（2026-10-08，B 墙优先落地）：主题 token 换梯（`app/globals.css`）→ 大厅 launcher（`app/page.tsx`）→ 门禁三态（`app/room/[id]/page.tsx`）→ 建房（`create-room-modal.tsx`）→ 媒体库 B（`openlist-modal.tsx` + `catalog-wall.tsx`：搜索即输入、直链识别、键盘层与 `?` 速查）→ 成员/清单/交接（`members-modal.tsx`/`playlist-modal.tsx`/`mpv-launch-modal.tsx`）→ 原语去阴影与焦点提亮（`ui/*`）。弹出组件 `Keycap` 新增于 `ui/keycap.tsx`。
- 验收证据：`tests/results/{catalog-logic,mkv-ui,mkv-chrome-fault,mkv-chrome-dual}-redesign.json`（全绿）；`npm test` 23/23；tsc/定向 eslint 0；隔离生产构建通过。`catalog-logic-acceptance.mjs` 已同步到"输入即搜索"交互（无提交按钮、防抖 600ms、清除走 aria-label）。
- 未动边界兑现：room-player.tsx、player-adapter、mkv 引擎、播放器视觉均未被本轮改动；草稿编辑页按用户裁决整体下线（见 §8）。
- 追加（2026-10-08）：草稿编辑页下线；刮削按钮与状态行同批下线（catalog 逻辑验收的 old-scrape 检查随功能删除，现为 6 项，其余五类陈旧性隔离不变）；音量条 `hidden sm:block` → `max-sm:hidden` 修复（Radix 滑条需要 flex 上下文，block 覆盖会让 track/range 塌成 0×0）；`next.config.ts` 加 `devIndicators:false`（dev 徽标压住底栏静音键）。复核：UI 探针 39 项、catalog 逻辑 6/6、`npm test` 23/23 通过。
- 追加（2026-10-08，品牌统一为 Banguru）：与桌面壳同一套品牌资产。`desktop-shell/public/banguru-logo.svg` → `web/public/banguru-logo.svg`（大厅字标 `<img>` 用，1024×1024 复古电视+爆米花桶）；同 SVG → `web/app/icon.svg`（Next 文件约定，新式浏览器标签页图标）；`desktop-shell/electron/assets/banguru-logo.ico` → `web/app/favicon.ico`。`layout.tsx` 站名改 `Banguru`（room 页继承）；room-player 错误文案改「此媒体需要 Banguru 桌面端」。**有意不改**的契约标识：`watchparty://` 深链协议、`watchparty_*` / `token_*` / `owner_*` localStorage 键、`X-WatchParty-Token` 头、socket/组件类名——均为运行时/存储契约，改名会丢用户会话。证据：`tests/results/brand-2026-10-08.json`（双 icon link 均 200、站名/字标/logosvg 核验、页面无旧品牌文本）。
- 追加（2026-10-08，浅色主题落地／用户选定"光 B"）：全站两态手动（存 `watchparty_theme`，首访跟系统一次，之后手动为准）。落地：`globals.css` 浅色做 `:root`（光 B 阶梯＋field＋elevated/ash/stone/key-bg 变量化）、深色留 `.dark`；`layout.tsx` 去硬编码 `dark` ＋ 防闪烁内联脚本＋`suppressHydrationWarning`；`lib/theme.ts`（read/system/resolve/apply/store）；大厅顶栏太阳/月亮切换（CSS 驱动无 hydration 抖动）；输入域/门禁与建房 PIN 格改 `bg-field`；弹窗遮罩主题化（`bg-black/45 dark:bg-black/70`）；primary 内键帽反色适配；**播放器面恒黑**＝房间 ready 在 html 钉 `.dark`、离开恢复（portal 弹窗一并覆盖）。坑：旧 dev 进程对 `globals.css` 的 watcher 失效（JS 热更、CSS 不更）→ 重启 dev 即好；改全局样式后必须重启核对。验收：双主题 live 探针全过（首访跟系统/手动持久/进房钉黑/离房还原/门禁跟主题）；mkv-ui 39/39、catalog 6/6、fault 11/11（房内钉黑后回归无感）；tsc 0、eslint 0、npm test 23/23、生产构建 exit 0。静态稿：`temp-html/light-theme-options-2026-10-08.html`。
- 追加（2026-10-08，字幕上传落地——前后端）：契约 `temp-html/subtitle-upload-contract-2026-10-08.md` 全条落地（后端：路由挂 rooms 家族、sqlite `data/watchparty-subtitles.sqlite`、媒体级持久、(media_id,name) 真 upsert、512KB 正文/32 条上限、房主按 owner 票判定、上传先认领 mediaId；前端：字幕菜单「上传字幕…」行＋房主 ✕ 删除＋`media-error-text` 5 新码含 SUBTITLE_TRACKS_FULL）。端到端验收 13/13 全过（`tests/results/subtitle-upload-2026-10-08.json`）：上传→菜单列出→**画布真实渲染上传字幕**→HTTP POST×1＋内容 GET→跨房间同 mediaId 可见可取→刷新仍在→房主删除 200 且生效→成员不见 ✕。回归：mkv-ui 复跑 39/39（首次 fullscreen-exited 为已知 headless flake，复跑即绿）、npm test 23/23、tsc 0。
- 追加（2026-10-08，大厅职责扩展裁决／grill 两轮）：**q6 顺序 a**（输入 → 继续观看 → 最近访问 → 状态行）＋**状态行**：常显"点＋文字"（正常＝`● 服务正常`；2026-10-08 用户改口：正常时也带文字，取代最初的裸点变体）；**q7 行式**（缩略图＋细进度条＋百分比，与最近访问同款行）；**q8 双入口**：输入行尾「浏览片源」为主动作 → 只读媒体库 → 选中 → 建房表单（片已带好，表单内可更换片源）；顶栏「创建房间」降为次级视觉（空房快捷路径，语义不变）；媒体库房外态动作条：确认/拒绝/入队/桌面端播放置灰，唯一主行动「用此片开房」，入房后恢复现状。栏宽提案 max-w-xl → max-w-2xl（672）。数据来源：继续观看＝本机 `watchparty_continue`（播放器侧写入由用户侧落＝q10a；首页只读渲染，空则整块隐藏）；最近访问＝门禁成功入房即写（含输码/链接入房）。契约依赖：只读浏览全押在游客凭据变更单（`temp-html/guest-read-contract-request-2026-10-08.md`）。**客户端侧已真实接线（2026-10-08 晚）**：`media-room-access.ts`＝房内房间头 / 房外游客凭据（`POST /api/media/guest-session`＋`X-WatchParty-Guest`，懒签发·内存缓存·并发去重·到期重签·404 回落旧文案）；`api.ts` 房外 401 作废重签重放一次；`media-image.tsx` 同步接游客头；服务端未落地前行为与文案与旧版一致。**服务端已落地（2026-10-08，12 分钟 TTL／8 条白名单／全局 403 守卫／限速）并端到端验收**：证据 `tests/results/guest-read-2026-10-08.json`（guest-session 一次签发 → 全部媒体读取带游客头、库与文件可浏览、写/批量置灰、「用此片开房」落建房表单带片）＋房内回归 `catalog-logic-guest-landed.json` 6/6。静态稿：`temp-html/lobby-expansion-options-2026-10-08.html`。

- 追加（2026-10-08，播放器设置落地／终版 handoff + 布局 B）：按 `temp-html/web-player-settings-grill-2026-10-08.html`（三轮 grill 终稿）落地。模型：有序语言列表（音轨/字幕各一，旧单值迁移为单元素列表；按顺序逐项匹配、精确标签→主语言回退、排除不支持、同级保序）+ 字幕来源优先级（外挂/内嵌，默认外挂；空表或无命中回退来源默认轨，来源缺失回退另一来源）+ 关闭字幕独立开关（显式关闭优先、重选解除）+ 普通文本字幕外观（字号 50–300、白/黄、描边开关、背景、底部位置上移 0＝自动安全区 / 5–30 手动，渲染端防裁切约束）+ 偏移 ±30s 步进 0.1（clamp）。**菜单手选不写全局列表**（只解除关闭；覆盖当前媒体、同媒体重试保留；换媒体按列表重应用）；播放速度/循环/自动下一项不入设置（房间状态）。UI＝布局 B 居中大窗（左分组导航：基础/字幕外观/字幕偏移/恢复），组件 `player-settings-dialog.tsx`；引擎 `draw()` 样式钩子含暂停态重绘（restart 路径）。验收：设置 E2E 17/17（语言列表增删移、来源切换、字号滑杆暂停重绘 68px、底部上移 108px、清偏移确认、重置回默认并重绘、刷新持久、手选不写列表）；mkv-ui 39/39、fault 全过、npm test 25/25、tsc/eslint 0、生产构建 exit 0。两个历史 helper（next-preferences / room-integration）的"手选写全局语言"旧断言已改到新语义（**next-preferences 全量套件本轮未复跑**，需隔离端口栈）。静态稿：`temp-html/web-player-settings-options-2026-10-08.html`（A/B/C 已选 B）。

- 追加（2026-10-09，媒体库尺寸/布局策略＝弹-B＋页-C 落地）：用户从 `temp-html/media-library-size-options-2026-10-09.html` 选定。落地：弹窗 `w-[min(92vw,1440px)] h-[min(86dvh,900px)]`（取代 1152×min(80dvh,780)）；整页内容壳 `max-w-[min(94vw,2240px)]`（取代 1680 cap）；右栏整页态加宽 **360**（弹窗态保持 320）；**标题墙改容器查询**（`@container` 于滚动容器，列序 `grid-cols-2 @sm:3 @3xl:4 @5xl:5 @7xl:6`）——列数随容器而非视口，弹/页两壳自然分化（2560：弹 1440 宽未选 6 列/选中 5 列；页 2240 宽 6 列；1280：弹 1178 未选 5 列/选中 4 列）。验收：`tests/results/media-library-size-bc.json` pass；catalog-logic 6/6（`catalog-logic-size-bc.json`）；npm test 25/25、tsc/eslint 0、生产构建 exit 0。截图 `%TEMP%/size-2560-modal.png`、`size-bc-full-2560.png`。

- 追加（2026-10-09/10，播放器设置追加裁决落地；前端 only，零服务端改动）：按 `temp-html/web-player-settings-grill-2026-10-09.html` 落地。模型（player-preferences v3，旧数据迁移：`subtitlesOff`→off 模式、outline 布尔→none/thin、background none/black→0%/50%）：字幕三模式 **media-default / prefer-list / off**（默认 media-default）；外观扩展 color4（白/黄/青/绿）· fontWeight2 · outline3（无/细/粗）· shadow3（无/柔和/强）· backgroundOpacity 0/25/50/75/100；快退/快进步长各存（5–30s，默认 10）；pictureFit contain/cover。统一决策函数 `decideSubtitleSelection`：默认标记→语言列表（跨外挂/内嵌候选：精确→主语言回退、不支持排除、同级按来源偏好打破平局、仍同级保轨道顺序）→关闭；prefer-list 空列表回退媒体默认（标记缺失时=引擎自身默认轨，仅此路径）；关闭最高优先级；手选按媒体覆盖、同媒体重试保留、重选解除关闭。**外挂字幕接口无默认标记，永不冒充"媒体默认轨"**（空列表/无语言的上传轨不再自动显示，只可列表命中或手选）。引擎/适配器：draw() 抽共享画布绘制器 `lib/mkv/subtitle-paint.ts`（MKV 画布 / 设置预览 / 原生覆盖层同一实现）；原生路径 VTT/SRT 由 `<track>` 改自绘 canvas 覆盖层（rAF+offset+全档外观）；画面缩放 object-contain/cover 同步主画布+字幕层（MKV 含 JASSUB 层，全屏同步；YouTube 不适用如实显示）。UI：设置窗 B 布局新增"播放"段，外观段加实时预览（两行中英示例），基础段三模式 chips，存储不可用提示（"仅本次会话生效"），重置含新字段；控制栏加 ⏪/⏩（tooltip 含步长），←/→ 键盘（弹层/交互控件内屏蔽），跳转走房间 seek 与既有角色权限。**"媒体默认轨"数据源核查（运行时证据）**：libav.js 6.10.9.0 webcodecs 构建 `ff_init_demuxer_file` 仅暴露 index/codecpar/codec_type/codec_id/time_base/duration/metadata，无 disposition 且未导出 `AVStream_disposition`；用 ffmpeg 造带 `-disposition default` 的 MKV 经同版本变体解封装，metadata 只有 language/ENCODER/DURATION → **内嵌默认标记不可得**；故未扩字幕元数据（服务端零改动），`EmbeddedTrack.default?` 预留，引擎后继能力可直接生效。验收（当前树全跑）：`tests/results/player-settings-v3-2026-10-10.json` 79/79（三模式含无标记回退闭合、语言命中/引擎默认回退、off 优先与重选解除、跨源平局 EXT/JP 端到端、外观档位实时预览与 MKV 画布 bold 45px/#00e5ff/线宽10.8/影40.5、cover/contain 含全屏、YouTube 不适用、刷新恢复、存储提示、重置、步长分存+按钮/键盘 ±30/−5 且改设置 revision 不变）；`native-overlay-2026-10-10.json`（原生覆盖层外观/偏移/缩放全过）；`player-settings-dual-2026-10-10.json`（双客户端偏好互不覆盖+房间同步）；`mkv-ui-settings-v3-regression.json` 39/39；npm test 27/27；tsc/eslint 0。基建：`make-ui-fixture.mjs` 可复现生成验收 fixture（1920×1080、2 音 2 字幕 eng/jpn、M## cue、8100s；用户真库预览栈未动）；mkv-local-server 白名单加 transferOwner；mkv-ui 退出全屏加与进入对称的重试+诊断（根因：弹窗关闭动画遮点）。截图 `%TEMP%/wp-settings-{basic,appearance,playback}.png`、`wp-room-controls.png`。

- 追加（2026-10-10，YouTube 播放契约前端接入；服务端契约由并行 agent 在途，前端只读其形状）：①`GET /api/media/capabilities` 新增读取 `platforms.youtube`（`contracts.ts` 可选类型，旧后端缺字段不阻塞任何流程）——媒体库直链行在契约声明 `requiresBrowserAccess` 时显示"浏览器内嵌播放 · 需能访问 youtube.com · 无需 API key"。②输入分类 `lib/youtube.ts` 镜像后端 `normalizeYouTubeSource`：裸 11 位 ID / `watch?v=` / `youtu.be` 单视频 → 提交规范化 `{kind:"youtube",videoId,title}`；**shorts/embed/playlist/channel/非 https 就地给出原因、不发请求**（旧 `parseYouTubeVideoId` 会误收 shorts/embed，已替换）；裸 ID 走搜索框下方内联行（不打断标题搜索）。③iframe 错误按事件 `data` 映射契约码（2/5/100/101+150/153→六码，其余 UNKNOWN；不再输出"受地区限制"式臆断）；脚本加载失败→`YOUTUBE_API_UNAVAILABLE`；播放器已确定不可用时的控制调用→`YOUTUBE_CONTROL_UNAVAILABLE`（每次挂载至多一次，加载窗口内的控制由 onReady 重放、不误报）。④本机状态隔离不变：错误/自动播放阻止/接口可用性只落 `loading…error` 本机相位，不发共享暂停；切源后旧实例回调全部失效。验收（当前树）：`tests/results/youtube-adapter-2026-10-10.json`（API 不可用→控制不可用去重、六码映射全表、旧回调失效、无 key 播放）；`tests/results/youtube-room-entry-2026-10-10.json`（watch 链与裸 ID 提交规范化各 revision +1、无 googleapis/key= 请求、无效视频错误后 revision/paused 不变、shorts 就地拒绝零请求）；`youtube-contract.test.mjs` 单测；回归 v3 79/79、mkv-ui 39/39、npm test 30/30、tsc/eslint 0。基建设置：fixture 生成器重建后照 `make-ui-fixture.mjs` 提示重启 18981/18983；18982 dev 需 `WATCHPARTY_NEXT_DIST_DIR=.next-fixture-18982 BACKEND_ORIGIN=http://127.0.0.1:18981 NEXT_PUBLIC_SOCKET_ORIGIN=http://127.0.0.1:18981`。
- 追加（2026-10-10，YouTube iframe 铺满修复，用户截图定位）：`new YT.Player` 未传 `width/height` 时 iframe 钉死 640×360（视频只占左上角、其余留黑）；改为 `width:"100%" height:"100%"`（比例由 YouTube 内部保持），类型同步 `number | string`。验收：`youtube-room-entry` 增至 31 项，含 `youtube-iframe-fills-stage`——真实 iframe 矩形与舞台**逐像素相等**（默认 1264×805；视口缩到 1000×700 后同帧跟随）、width/height 属性为 "100%"、播放截图 `%TEMP%/wp-youtube-fill.png`；`youtube-adapter` 12、native 7（其"负偏移"负断言改为确定性正断言：-0.5s 时 4.2s 显示 4–6s cue 且 1–3s cue 出窗）、v3 79、mkv-ui 39、dual 14、npm test 31/31（含并行许可证会话的 legal-distribution 用例）、eslint 0（`web/legal/` 是并行会话的原样源码转储，其自身 tsc 错不属本域）。

## 附录 A · cinema 面登记（冻结参考，只读）

- 舞台与浮层背景：`#000`；浮层渐变 `black → transparent`。
- 强调色：sky 系（`sky-400/500`）——连接态、当前轨、选区；与工具面的语义色体系**不互通**。
- 控制栏：icon-sm 28–32、mono 时间、自动隐藏（浮层 C）机制不变。
- 播放器内菜单（字幕/音轨/更多）样式维持现状；其内部文本不受 §3 下限约束（冻结面内自洽）。
