import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Setup Guide（形态 A）的组件级测试。
// 约定与 backend-address.test.mjs 相同：手工转译 TS/TSX 后在 vm 里跑，不起 Electron。
// 面板是受控组件（props 进、回调出），所以静态渲染就能断言文案、禁用态与端口口径；
// 步骤迁移由 setup-guide-steps.ts 的纯函数覆盖。

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const shellRoot = path.resolve(testsDir, '..')
const componentsDir = path.join(shellRoot, 'src', 'components')
const nodeRequire = createRequire(path.join(shellRoot, 'package.json'))

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
}

function resolveSource(request, fromDir) {
  const base = request.startsWith('.') ? path.resolve(fromDir, request) : request
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  const hit = candidates.find((candidate) => existsSync(candidate))
  if (!hit) throw new Error(`setup-guide test cannot resolve ${request} from ${fromDir}`)
  return hit
}

/** 最小 TS/TSX 加载器：相对导入递归转译，裸模块走 desktop-shell 的 node_modules。 */
function loadModule(relativePath) {
  const entry = resolveSource(`./${relativePath}`, componentsDir)
  const cache = new Map()
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename)
    const module = { exports: {} }
    cache.set(filename, module)
    const source = readFileSync(filename, 'utf8')
    const js = ts.transpile(source, compilerOptions, filename)
    const localRequire = (id) => {
      if (id.startsWith('.')) return load(resolveSource(id, path.dirname(filename))).exports
      return nodeRequire(id)
    }
    vm.runInNewContext(js, {
      require: localRequire,
      exports: module.exports,
      module,
      console,
      process,
      URL,
      setTimeout,
      clearTimeout,
    }, { filename })
    return module
  }
  return load(entry).exports
}

const React = nodeRequire('react')
const { renderToStaticMarkup } = nodeRequire('react-dom/server')
const steps = loadModule('setup-guide-steps.ts')
const guide = loadModule('setup-guide.tsx')

const render = (element) => renderToStaticMarkup(element)

/** 取出含指定文本的 <button> 标签本体，便于断言 disabled。 */
function buttonTag(html, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<button[^>]*>${escaped}</button>`))
  assert.ok(match, `找不到按钮「${text}」`)
  return match[0]
}

/** class 里含 Tailwind 的 `disabled:opacity-40`，所以先剥掉 class 再判断 disabled 属性。 */
function hasDisabled(tag) {
  return /\sdisabled(=""|\s|>)/.test(tag.replace(/\sclass="[^"]*"/, ''))
}

const noop = () => {}

test('步骤序、标签与迁移表', () => {
  const { SETUP_STEP_ORDER, SETUP_STEP_LABELS, transition, stepIndex, BANGURU_PATH_STEPS } = steps
  assert.deepEqual([...SETUP_STEP_ORDER], ['banguru-origin', 'verify', 'account', 'linkle-origin', 'linkle-invite'])
  assert.deepEqual(Object.keys(SETUP_STEP_LABELS), [...SETUP_STEP_ORDER])
  assert.deepEqual([...BANGURU_PATH_STEPS], ['banguru-origin', 'verify', 'account'])
  assert.equal(stepIndex('linkle-invite'), 4)

  assert.equal(transition('banguru-origin', 'next'), 'verify')
  assert.equal(transition('banguru-origin', 'goto-linkle'), 'linkle-origin')
  assert.equal(transition('banguru-origin', 'back'), 'banguru-origin')
  assert.equal(transition('verify', 'next'), 'account')
  assert.equal(transition('verify', 'back'), 'banguru-origin')
  assert.equal(transition('account', 'next'), 'linkle-origin')
  assert.equal(transition('account', 'back'), 'verify')
  assert.equal(transition('linkle-origin', 'next'), 'linkle-invite')
  assert.equal(transition('linkle-origin', 'back'), 'account')
  assert.equal(transition('linkle-invite', 'back'), 'linkle-origin')
  assert.equal(transition('linkle-invite', 'next'), 'linkle-invite', '末步没有 next，原地不动')
})

test('昵称默认值：生成 8 位小写字母数字 ID', () => {
  assert.match(steps.generateNickname(), /^[a-z0-9]{8}$/, '默认昵称应为 8 位小写字母数字')
  assert.equal(steps.generateNickname(() => 0, 8), 'aaaaaaaa', '可注入 rng，便于断言')
  assert.equal(steps.generateNickname(() => 0.999999, 4), '9999', 'rng 上界不越位')
  const many = new Set(Array.from({ length: 64 }, () => steps.generateNickname()))
  assert.ok(many.size > 1, '多次生成不应恒定同一个值')
})

test('完成横幅第二行由 readiness 驱动，缺信息时整行不渲染', () => {
  // 组件级 status 是 up|down（顶层才是 ready|degraded）——照 server/core/http/readiness.ts 的真实形状。
  const ready = {
    status: 'ready',
    service: 'watchparty',
    readinessVersion: 1,
    checkedAt: 1790409399252,
    components: {
      core: { status: 'up' },
      openlist: { status: 'up', code: 'OPENLIST_OK', latencyMs: 65 },
      mediaRoots: { status: 'up', roots: [{ name: 'Anime', ok: true, code: 'MEDIA_ROOT_OK' }] },
    },
    diagnostics: [],
  }
  assert.equal(steps.readinessSummary(ready), '媒体源：已就绪。媒体库：已就绪')

  // 未配置类信息只在 diagnostics[]，不在 components.openlist.code（那里只放 MediaHealthCode）。
  const unconfigured = { ...ready, components: { ...ready.components, openlist: { status: 'down', code: 'OPENLIST_UNREACHABLE' } }, diagnostics: [{ severity: 'error', code: 'OPENLIST_URL_NOT_CONFIGURED', remediation: 'OPENLIST_URL_SETUP' }] }
  assert.equal(steps.readinessSummary(unconfigured), '媒体源：未配置。媒体库：已就绪')

  const missingPassword = { ...ready, components: { ...ready.components, openlist: { status: 'down', code: 'OPENLIST_AUTH_FAILED' } }, diagnostics: [{ severity: 'error', code: 'OPENLIST_PASSWORD_NOT_CONFIGURED' }] }
  assert.equal(steps.readinessSummary(missingPassword), '媒体源：未配置。媒体库：已就绪')

  // 真的有故障：没有未配置诊断，就该说不可用。
  const broken = { ...ready, status: 'degraded', components: { ...ready.components, openlist: { status: 'down', code: 'OPENLIST_UNREACHABLE' } } }
  assert.equal(steps.readinessSummary(broken), '媒体源：不可用。媒体库：已就绪')

  // 媒体库根目录探测：逐根 ok:false 也算路径未找到。
  const badRoot = { ...ready, status: 'degraded', components: { ...ready.components, mediaRoots: { status: 'down', roots: [{ name: 'Anime', ok: false, code: 'MEDIA_ROOT_NOT_FOUND' }] } } }
  assert.equal(steps.readinessSummary(badRoot), '媒体源：已就绪。媒体库：路径未找到')

  // 老后端（缺端点）与探针失败都是 null/undefined：第二行不出现，绝不能渲染成降级。
  assert.equal(steps.readinessSummary(null), null)
  assert.equal(steps.readinessSummary(undefined), null)
  assert.equal(steps.readinessSummary({ status: 'ready', components: { core: { status: 'up' } } }), null)

  // 本地化 message 不参与判断：改 message 不改结论。
  const localized = { ...ready, components: { ...ready.components, openlist: { status: 'up', code: 'OPENLIST_OK', message: 'sollte ignoriert werden' } } }
  assert.equal(steps.readinessSummary(localized), '媒体源：已就绪。媒体库：已就绪')
})

test('首启向导：步骤条 5 步、不预填、端口口径只在提示里', () => {
  const services = {
    loadInitial: async () => ({ backendOrigin: null, nickname: '', linkleOrigin: '', credentialsConfigured: false }),
    saveBanguruOrigin: async () => ({ ok: true }),
    verifyBanguru: async () => ({ ok: false, message: '', hint: '' }),
    verifyLinkle: async () => ({ ok: true, line: null }),
    promptSiteCredentials: async () => false,
    saveNickname: async () => ({ ok: true }),
    saveLinkleOrigin: async () => ({ ok: true }),
    redeemLinkleInvite: async () => ({ ok: false, message: '' }),
    finish: async () => ({ ok: true }),
  }
  const html = render(React.createElement(guide.SetupGuide, { services, onDone: noop }))

  for (const label of Object.values(steps.SETUP_STEP_LABELS)) assert.ok(html.includes(label), `步骤条缺少「${label}」`)
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1, '同时只能有一个当前步骤')
  assert.ok(html.includes('欢迎使用 Banguru'))

  // 不预填：输入框的 value 为空，端口号只出现在 hint / placeholder。
  assert.doesNotMatch(html, /value="[^"]*8080/)
  assert.match(html, /placeholder="http:\/\/主机:8080"/)
  assert.ok(!html.includes('18381'), '退役端口 18381 不得出现')
  assert.ok(!html.includes('18082'), '退役端口 18082 不得出现')
})

test('步骤 1：地址为空时不能前进，可跳过或跳到 Linkle', () => {
  const props = { origin: '', error: null, busy: false, onOriginChange: noop, onNext: noop, onSkipWizard: noop, onSkipBanguru: noop }
  const html = render(React.createElement(guide.BanguruOriginPanel, props))

  assert.match(html, /8080/, 'hint 保留 8080 端口口径')
  assert.ok(hasDisabled(buttonTag(html, '下一步：验证连接')), '空地址时下一步禁用')
  assert.ok(!hasDisabled(buttonTag(html, '跳过向导')), '跳过向导始终可用')
  assert.ok(html.includes('还没有 Banguru 服务器？跳到 Linkle 配置 →'))
  assert.ok(html.includes('远程服务器请用 HTTPS'))

  const filled = render(React.createElement(guide.BanguruOriginPanel, { ...props, origin: 'https://banguru.example.com' }))
  assert.ok(!hasDisabled(buttonTag(filled, '下一步：验证连接')))
  assert.match(filled, /value="https:\/\/banguru\.example\.com"/)
})

test('步骤 1：地址错误以行内错误展示，且不泄漏凭据', () => {
  const html = render(React.createElement(guide.BanguruOriginPanel, {
    origin: 'localhost:8080', error: '请填写完整地址，例如 https://banguru.example.com', busy: false,
    onOriginChange: noop, onNext: noop, onSkipWizard: noop, onSkipBanguru: noop,
  }))
  assert.match(html, /role="alert"/)
  assert.ok(html.includes('请填写完整地址'))
})

test('步骤 2：验证成功展示四行状态，失败给下一步并允许保存继续', () => {
  const okOutcome = { ok: true, statusLine: '在线 · 服务正常', protocolLine: 'v2', capabilityLine: '创建 · 加入 · 恢复 · 搜索 · 队列 · 网页交接 均可用', accountLine: '未设置（服务器未要求 Basic Auth）' }
  const okHtml = render(React.createElement(guide.VerifyPanel, {
    origin: 'https://banguru.example.com', verify: { kind: 'done', outcome: okOutcome }, onBack: noop, onRetry: noop, onContinue: noop,
  }))
  for (const line of ['状态', '协议', '能力', '站点账号', '在线 · 服务正常', 'v2']) assert.ok(okHtml.includes(line), `验证成功缺少「${line}」`)
  assert.ok(okHtml.includes('验证只检查服务器访问，不会加入房间'))
  assert.ok(!hasDisabled(buttonTag(okHtml, '保存并继续')))

  const failOutcome = { ok: false, message: '无法连接 http://192.168.1.10:8080。', hint: '请确认 Banguru 后端已启动（默认监听 8080）。' }
  const failHtml = render(React.createElement(guide.VerifyPanel, {
    origin: 'http://192.168.1.10:8080', verify: { kind: 'done', outcome: failOutcome }, onBack: noop, onRetry: noop, onContinue: noop,
  }))
  assert.ok(failHtml.includes('无法连接'))
  assert.ok(failHtml.includes('默认监听 8080'), '失败态必须给出下一步做什么')
  assert.ok(!hasDisabled(buttonTag(failHtml, '保存并继续')), '失败也允许保存并继续，不阻断向导')

  const runningHtml = render(React.createElement(guide.VerifyPanel, {
    origin: 'https://banguru.example.com', verify: { kind: 'running' }, onBack: noop, onRetry: noop, onContinue: noop,
  }))
  assert.ok(runningHtml.includes('正在验证'))
  assert.ok(hasDisabled(buttonTag(runningHtml, '重试验证')))
})

test('步骤 3：昵称必填，站点账号可跳过且不复述密码', () => {
  const base = { credentialsConfigured: false, nickname: '', busy: false, onPromptCredentials: noop, onNicknameChange: noop, onBack: noop, onNext: noop }
  const html = render(React.createElement(guide.AccountPanel, base))
  assert.ok(hasDisabled(buttonTag(html, '下一步：Linkle 服务器')), '空昵称不能前进')
  assert.ok(html.includes('站点登录（Basic Auth）'))
  assert.ok(html.includes('Windows 凭据管理器'))
  assert.ok(html.includes('设置账号和密码'))
  assert.ok(html.includes('跳过'))

  const filled = render(React.createElement(guide.AccountPanel, { ...base, nickname: '本机用户', credentialsConfigured: true }))
  assert.ok(!hasDisabled(buttonTag(filled, '下一步：Linkle 服务器')))
  assert.ok(filled.includes('已保存账号和密码'))
  assert.ok(!filled.includes('设置账号和密码'), '已配置后不再提供重复设置入口')
})

test('步骤 4：Linkle 地址不预填，可整体跳过，18380 只作调试栈口径', () => {
  const idle = { kind: 'idle' }
  const html = render(React.createElement(guide.LinkleOriginPanel, {
    linkleOrigin: '', error: null, busy: false, verify: idle, onVerify: noop, onLinkleOriginChange: noop, onBack: noop, onSkipLinkle: noop, onNext: noop,
  }))
  assert.match(html, /placeholder="https:\/\/music\.example\.com"/)
  assert.match(html, /127\.0\.0\.1:18380/, '本地调试栈口径写在 hint')
  assert.doesNotMatch(html, /value="[^"]*18380/)
  assert.ok(hasDisabled(buttonTag(html, '保存并继续')), '空地址时保存禁用')
  assert.ok(hasDisabled(buttonTag(html, '验证媒体源')), '空地址时不能验证')
  assert.ok(!hasDisabled(buttonTag(html, '跳过 Linkle')))
  assert.ok(html.includes('Linkle 侧不允许非回环 HTTP'))
  assert.ok(!html.includes('媒体源：'), '还没验证时不渲染媒体源行')
})

test('步骤 4：Linkle readiness 只认码，null 整行不渲染', () => {
  const ready = { mediaSource: 'up', mediaSourceCode: 'NETEASE_OK', diagnosticCodes: [] }
  assert.equal(steps.linkleReadinessLine(ready), '媒体源：已就绪')

  // 未配置是部署者的 env，不是用户填错地址；码只在 diagnostics[]，组件级仍是 down。
  const unconfigured = { mediaSource: 'down', mediaSourceCode: 'NETEASE_UNREACHABLE', diagnosticCodes: ['NETEASE_URL_NOT_CONFIGURED'] }
  assert.equal(steps.linkleReadinessLine(unconfigured), '媒体源：服务端未配置')
  assert.ok(!steps.linkleReadinessLine(unconfigured).includes('请检查你的地址'))

  assert.equal(steps.linkleReadinessLine({ mediaSource: 'down', mediaSourceCode: 'NETEASE_UNREACHABLE', diagnosticCodes: [] }), '媒体源：不可达')
  assert.equal(steps.linkleReadinessLine({ mediaSource: 'down', mediaSourceCode: 'NETEASE_TIMEOUT', diagnosticCodes: [] }), '媒体源：超时')
  assert.equal(steps.linkleReadinessLine({ mediaSource: 'down', mediaSourceCode: 'NETEASE_BAD_RESPONSE', diagnosticCodes: [] }), '媒体源：服务异常')

  // 组件级 status 只有 up|down；顶层 ready|degraded 不参与这一行。
  assert.equal(steps.linkleReadinessLine({ status: 'ready', mediaSource: 'down', mediaSourceCode: 'SOMETHING_ELSE', diagnosticCodes: [] }), '媒体源：不可用')

  assert.equal(steps.linkleReadinessLine(null), null)
  assert.equal(steps.linkleReadinessLine(undefined), null)
  assert.equal(steps.linkleReadinessLine({ mediaSource: null, mediaSourceCode: null, diagnosticCodes: [] }), null)

  const panel = { linkleOrigin: 'https://music.example.com', error: null, busy: false, onVerify: noop, onLinkleOriginChange: noop, onBack: noop, onSkipLinkle: noop, onNext: noop }
  const hidden = render(React.createElement(guide.LinkleOriginPanel, { ...panel, verify: { kind: 'done', outcome: { ok: true, line: null } } }))
  assert.ok(!hidden.includes('媒体源：'), 'readiness 为 null 时整行不渲染')
  const shown = render(React.createElement(guide.LinkleOriginPanel, { ...panel, verify: { kind: 'done', outcome: { ok: true, line: '媒体源：已就绪' } } }))
  assert.ok(shown.includes('媒体源：已就绪'))
  const failed = render(React.createElement(guide.LinkleOriginPanel, { ...panel, verify: { kind: 'done', outcome: { ok: false, message: '无法连接 Linkle 服务。' } } }))
  assert.ok(failed.includes('无法连接 Linkle 服务。'))
  assert.ok(!failed.includes('媒体源：'), '连不上服务时不把媒体源渲染成降级')
})

test('步骤 5：邀请码可选、password 型、不回显，跳过与完成并存', () => {
  const html = render(React.createElement(guide.LinkleInvitePanel, {
    linkleOrigin: 'https://music.example.com', busy: false, finishError: null, onBack: noop, onSkip: noop, onFinish: noop,
    redeem: async () => ({ ok: true, accountName: '夜风' }),
  }))
  assert.ok(html.includes('邀请码（可选）'))
  assert.match(html, /type="password"/)
  assert.match(html, /placeholder="粘贴一次性邀请码"/)
  assert.match(html, /autocomplete="off"/i)
  assert.ok(html.includes('不会被保存、显示或写入日志'))
  assert.ok(!hasDisabled(buttonTag(html, '跳过，稍后在 Linkle 大厅兑换')))
  assert.ok(!hasDisabled(buttonTag(html, '完成')))
  assert.ok(hasDisabled(buttonTag(html, '兑换')), '空邀请码时兑换禁用')
  assert.ok(html.includes('https://music.example.com'), '展示目标服务器')

  const withError = render(React.createElement(guide.LinkleInvitePanel, {
    linkleOrigin: 'https://music.example.com', busy: false, finishError: '保存完成状态失败，请重试。', onBack: noop, onSkip: noop, onFinish: noop,
    redeem: async () => ({ ok: false, message: '' }),
  }))
  assert.ok(withError.includes('保存完成状态失败'))
  assert.ok(!withError.includes('18082') && !withError.includes('18381'))
})
