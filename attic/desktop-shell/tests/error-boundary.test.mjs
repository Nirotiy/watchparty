import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// ErrorBoundary（M2 键盘与读屏批）的组件级测试：手工转译后在 vm 里跑。
// 直接构造实例并置入错误态，断言渲染出的兜底文案与恢复入口。

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
  if (!hit) throw new Error(`error-boundary test cannot resolve ${request} from ${fromDir}`)
  return hit
}

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
const { AppErrorBoundary } = loadModule('error-boundary.tsx')

test('无错误时透传 children', () => {
  const html = renderToStaticMarkup(React.createElement(AppErrorBoundary, null, React.createElement('div', { id: 'ok' }, '正常内容')))
  assert.match(html, /id="ok"/)
  assert.ok(!html.includes('界面出错了'))
})

test('错误态渲染兜底文案、错误信息与重载入口', () => {
  const boundary = new AppErrorBoundary({ children: null })
  boundary.state = { error: new Error('boom-xyz') }
  const html = renderToStaticMarkup(boundary.render())
  assert.ok(html.includes('界面出错了'))
  assert.ok(html.includes('boom-xyz'), '错误信息可见，便于诊断')
  assert.ok(html.includes('重新载入界面'), '给出唯一恢复入口')
  assert.ok(html.includes('<button'), '恢复入口是可点击的按钮')
})
