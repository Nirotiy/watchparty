import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// M2-3 统一 TabBar 的组件级测试。
// 约定与 setup-guide.test.mjs 相同：手工转译 TS/TSX 后在 vm 里跑，不起 Electron。

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
  const base = request.startsWith('@/') ? path.join(shellRoot, 'src', request.slice(2))
    : request.startsWith('.') ? path.resolve(fromDir, request) : request
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  const hit = candidates.find((candidate) => existsSync(candidate))
  if (!hit) throw new Error(`tabs test cannot resolve ${request} from ${fromDir}`)
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
      if (id.startsWith('.') || id.startsWith('@/')) return load(resolveSource(id, path.dirname(filename))).exports
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
const { nextTabIndex, TabBar, TabBarItem } = loadModule('ui/tabs.tsx')
const noop = () => {}

test('nextTabIndex：方向键环绕、Home/End、越界收敛', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 3), 1)
  assert.equal(nextTabIndex('ArrowRight', 2, 3), 0, '右到底环绕回第一个')
  assert.equal(nextTabIndex('ArrowLeft', 0, 3), 2, '左到底环绕回末个')
  assert.equal(nextTabIndex('ArrowLeft', 1, 3), 0)
  assert.equal(nextTabIndex('Home', 2, 3), 0)
  assert.equal(nextTabIndex('End', 0, 3), 2)
  assert.equal(nextTabIndex('ArrowUp', 1, 3), null, '垂直方向键不参与横向 tab')
  assert.equal(nextTabIndex('Enter', 1, 3), null)
  assert.equal(nextTabIndex('ArrowRight', 0, 0), null, '没有 tab 时不动作')
  assert.equal(nextTabIndex('ArrowRight', 5, 3), 0, '越界当前值先收敛到末位(2)再右移环绕到 0')
  assert.equal(nextTabIndex('ArrowLeft', 5, 3), 1, '同上，左移从末位到 1')
  assert.equal(nextTabIndex('ArrowLeft', -1, 3), 2, '负数收敛到 0 再左移环绕')
})

test('TabBar / TabBarItem：aria 关联与 roving tabindex', () => {
  const html = renderToStaticMarkup(React.createElement(
    TabBar,
    { value: 'a', onValueChange: noop, panelId: 'demo-panel', idPrefix: 'demo-tab', label: '示例切换' },
    React.createElement(TabBarItem, { value: 'a' }, '甲'),
    React.createElement(TabBarItem, { value: 'b' }, '乙'),
  ))
  assert.match(html, /role="tablist"/, '容器是 tablist')
  assert.match(html, /aria-label="示例切换"/)
  assert.match(html, /<button[^>]*role="tab"/, '两个条目都是 tab')
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2)
  assert.match(html, /id="demo-tab-a"/)
  assert.match(html, /id="demo-tab-b"/)
  assert.match(html, /aria-selected="true"/)
  assert.match(html, /aria-selected="false"/)
  assert.equal((html.match(/aria-controls="demo-panel"/g) ?? []).length, 2, '两个 tab 都指向面板 id')
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'roving：只有选中的 tab 可 Tab 进入')
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 1)
  const active = html.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? ''
  assert.match(active, /tabindex="0"/, '选中项 tabindex=0')
  assert.match(active, /data-tab-value="a"/, '键盘导航靠 data-tab-value 取值')
})

test('TabBarItem 脱离 TabBar 使用会明确报错', () => {
  assert.throws(() => renderToStaticMarkup(React.createElement(TabBarItem, { value: 'a' }, '甲')), /必须在 TabBar 内使用/)
})
