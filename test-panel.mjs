// Static contract test for the browser half: load lib/client.js the way the DSH
// module loader does (register a factory, then materialize it with a stubbed
// React) and assert the conversation.view registration it produces.
// The visual side is checked separately in panel-dev/ (real Chrome + bus data).
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, 'dsh-bundle', 'lib', 'client.js')
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'dsh-bundle', 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// 1. manifest contract: the host composes browser bundles from exports["./client"] + dsh.client
ok('exports["./client"] points at the bundle', PKG.exports?.['./client'] === './lib/client.js')
ok('dsh.manifestVersion is declared', PKG.dsh?.manifestVersion === 1)
ok('dsh.client.platform is web', PKG.dsh?.client?.platform === 'web')
ok('dsh.client.inject lists the shells it needs',
  Array.isArray(PKG.dsh?.client?.inject) &&
  PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots') &&
  PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'),
  JSON.stringify(PKG.dsh?.client?.inject))
ok('main entry exists', fs.existsSync(path.join(HERE, 'dsh-bundle', PKG.main)))
ok('client bundle exists', fs.existsSync(path.join(HERE, 'dsh-bundle', PKG.exports['./client'])))
ok('files[] ships the browser half', Array.isArray(PKG.files) && PKG.files.includes('lib/client.js'))

// The panel only appears if the package is also a live Loader entry: dsh.client alone
// gets scanned only for entries that exist in the roster, so the patch must insert it.
const patch = fs.readFileSync(path.join(HERE, 'dsh-bundle', 'cordis.patch.yml'), 'utf8')
ok('patch inserts the panel Loader entry', /-\s*id:\s*codex-bridge-panel[\s\S]{0,120}name:\s*'?@local\/codex-bridge'?/.test(patch))
ok('patch keeps the MCP client entry', /-\s*id:\s*codex-bridge-mcp[\s\S]{0,120}name:\s*'?@deepseek-ai\/dsh-mcp-client'?/.test(patch))

// 2. module contract: idempotent registration, exports.apply / exports.inject
const source = fs.readFileSync(CLIENT, 'utf8')
const registrations = []
let loaded = null
const reactStub = {
  // A real element shape: the badge assertions below render through this stub.
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
  console: { warn: () => {}, log: () => {} },
  fetch: () => Promise.reject(new Error('no network in unit test')),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  AbortController: class { constructor() { this.signal = null } abort() {} },
  document: { hidden: true },
  URLSearchParams,
  encodeURIComponent,
  JSON, Math, Date, String, Number, Object, Array, Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

ok('bundle calls __ModuleLoader__.load', !!loaded)
ok('bundle id equals the package name', loaded?.id === PKG.name, loaded?.id)

const requireStub = (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: reactStub.Fragment }
  throw new Error('unexpected require: ' + name)
}
const mods = loaded.factory(requireStub)
ok('exports.apply is a function', typeof mods.apply === 'function')
ok('exports.inject requests slots + locale',
  Array.isArray(mods.inject) && mods.inject.includes('slots') && mods.inject.includes('locale'), JSON.stringify(mods.inject))

const injected = []
let effectsRun = 0
const ctx = {
  slots: {
    inject: (name, factory) => { injected.push(name); factory() },
    register: (spec, Component) => { registrations.push({ spec, Component }); return () => {} },
  },
  locale: { getLocale: () => ({ active: 'zh-CN' }), register: () => {} },
  effect: (fn) => { effectsRun++; return fn() },
  get: () => undefined,
}
mods.apply(ctx)

const views = registrations.filter((r) => r.spec?.name === 'conversation.view')
const badges = registrations.filter((r) => r.spec?.name === 'sidebar.session.row.trailing')
ok('slots.inject covers both seats', injected.includes('conversation.view') && injected.includes('sidebar.session.row.trailing'), JSON.stringify(injected))
ok('registers exactly one view', views.length === 1, String(views.length))
ok('the badge poller is installed as a disposable effect', effectsRun === 1, String(effectsRun))
const spec = views[0]?.spec
ok('view name is conversation.view', spec?.name === 'conversation.view')
ok('view id is codex-bridge', spec?.id === 'codex-bridge')
ok('view order is a number', typeof spec?.order === 'number')
ok('label is a function returning 桥 (zh)', typeof spec?.label === 'function' && spec.label() === '桥', String(spec?.label?.()))
ok('inject() maps a session id to props',
  typeof spec?.inject === 'function' && spec.inject('session-abc').sessionId === 'session-abc',
  JSON.stringify(spec?.inject?.('session-abc')))
ok('component is a function component', typeof views[0]?.Component === 'function')

// The count lives in the sidebar row: conversation.view can only carry { id, label }.
const badgeSpec = badges[0]?.spec
ok('registers one sidebar badge', badges.length === 1, String(badges.length))
ok('badge id is codex-bridge-unread', badgeSpec?.id === 'codex-bridge-unread', badgeSpec?.id)
ok('badge sits after the shipped row icons', badgeSpec?.order === 50, String(badgeSpec?.order))
const badgeInject = badgeSpec?.inject?.()
ok('badge injects a subscribable store',
  typeof badgeInject?.hooks?.bridgeUnread?.getSnapshot === 'function' &&
  typeof badgeInject?.hooks?.bridgeUnread?.subscribe === 'function',
  JSON.stringify(Object.keys(badgeInject?.hooks || {})))
{
  const badge = badges[0].Component
  const lit = flatten(badge({ sessionId: 'session-abc', bridgeUnread: { 'session-abc': 3 } })).join(' ')
  const dark = badge({ sessionId: 'session-abc', bridgeUnread: { 'session-xyz': 3 } })
  const idle = badge({ sessionId: 'session-abc', bridgeUnread: {} })
  ok('badge shows this session count', lit === '3', JSON.stringify(lit))
  ok('badge ignores other lanes', dark === null, JSON.stringify(dark))
  ok('badge renders nothing at zero', idle === null, JSON.stringify(idle))
  ok('badge caps the number', flatten(badge({ sessionId: 's', bridgeUnread: { s: 120 } })).join(' ') === '99+')
}

// 3. behaviour: run the real component against a snapshot with a minimal hook runner.
// The static half above only proves the registration; this proves the panel renders the
// bus answer, that a bad answer lands in the error state, and that the snapshot wins.
function makeHooks() {
  const slots = new Map()
  let index = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    Fragment: 'Fragment',
    useState(init) {
      const i = index++
      if (!slots.has(i)) slots.set(i, typeof init === 'function' ? init() : init)
      return [slots.get(i), (next) => {
        slots.set(i, typeof next === 'function' ? next(slots.get(i)) : next)
      }]
    },
    useRef(init) {
      const i = index++
      if (!slots.has(i)) slots.set(i, { current: init })
      return slots.get(i)
    },
    useCallback(fn, deps) {
      const i = index++, old = slots.get(i)
      if (old && deps && deps.every((v, n) => Object.is(v, old.deps[n]))) return old.fn
      slots.set(i, { fn, deps }); return fn
    },
    useEffect(fn, deps) {
      const i = index++, old = slots.get(i)
      if (old && deps && deps.length === old.deps?.length && deps.every((v, n) => Object.is(v, old.deps[n]))) return
      effects.push(() => { old?.cleanup?.(); slots.set(i, { deps, cleanup: fn() }) })
    },
  }
  return {
    React,
    begin() { index = 0 },
    runEffects() { const list = effects; effects = []; for (const fn of list) fn() },
    unmount() { for (const slot of slots.values()) slot?.cleanup?.(); effects = [] },
  }
}

function flatten(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out }
  // Function components are rendered here too, otherwise a PeerCard/MessageRow would
  // "pass" as a missing string and the assertions below would prove nothing.
  if (typeof node.type === 'function') return flatten(node.type(node.props), out)
  if (node.children) flatten(node.children, out)
  return out
}

async function renderPanel({ fetchImpl, now }) {
  const hooks = makeHooks()
  let loaded = null
  const requests = []
  const timers = new Map(); let timerId = 0
  const Clock = now === undefined ? Date : class extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    console: { warn: () => {}, log: () => {} },
    fetch: (url, init) => { requests.push({ url, init }); return fetchImpl(url, init) },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }, clearTimeout: id => timers.delete(id),
    AbortController: class { constructor() { this.signal = { aborted: false } } abort() { this.signal.aborted = true } },
    document: { hidden: true },
    URLSearchParams, encodeURIComponent,
    JSON, Math, Date: Clock, String, Number, Object, Array, Error,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const requireStub = (name) => {
    if (name === 'react') return hooks.React
    if (name === 'react/jsx-runtime') return { jsx: hooks.React.createElement, jsxs: hooks.React.createElement, Fragment: 'Fragment' }
    throw new Error('unexpected require: ' + name)
  }
  const mods = loaded.factory(requireStub)
  let captured = null
  mods.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (spec, Component) => {
        if (spec?.name === 'conversation.view') captured = Component
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'zh-CN' }), register: () => {} },
  })
  hooks.begin()
  captured({ sessionId: 'session-abc' })
  hooks.runEffects()
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  const materialize = node => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(materialize)
    if (typeof node.type === 'function') return materialize(node.type(node.props))
    return { ...node, children: node.children?.map(materialize) }
  }
  const render = () => { hooks.begin(); const tree = materialize(captured({ sessionId: 'session-abc' })); hooks.runEffects(); return tree }
  return { get text() { return flatten(render()).join(' ') }, requests, render,
    settle: async () => { render(); for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); return render() },
    unmount: () => hooks.unmount(),
    timeOut: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn() } },
  }
}

const snapshot = {
  ok: true, seq: 7, generatedAt: new Date().toISOString(), dir: 'D:\\tmp\\state',
  peers: [{ peer: 'dsh', cursor: 7, unread: 0 }, { peer: 'codex', cursor: 5, unread: 1 }, { junk: 1 }],
  recent: [
    { seq: 7, ts: new Date().toISOString(), from: 'dsh', to: 'codex', kind: 'task', body: 'do the thing', delivery: { state: 'delivered', target: 'thread-1', expiresIn: 0 } },
    { seq: 6, ts: new Date().toISOString(), from: 'dsh', to: 'codex', kind: 'task', body: 'still in flight', delivery: { state: 'claimed', peer: 'codex', target: 'thread-1', expiresIn: 42 } },
    null,
  ],
  codex: [{ id: 'thread-1', lastUser: 'fix the bus', cwd: 'C:\\work\\proj', ageSeconds: 30, status: 'active', source: 'vscode' }, null],
  lanes: { 'codex|thread-1': 7 },
  unreadLanes: { 'session-abc': 2 },
  // Grouped by the bus from the cwds it saw. Two projects, one with mail waiting.
  projects: [
    { id: 'abc12345', cwd: 'C:\\work\\proj', sessions: 1, threads: 2, unread: 3 },
    { id: 'def67890', cwd: 'C:\\work\\other', sessions: 1, threads: 1, unread: 0 },
    { junk: true },
  ],
}
snapshot.recent[0].delivery.turn = { state: 'completed' }
snapshot.recent.push({ seq: 5, from: 'dsh', to: 'codex', body: 'failed turn', delivery: { state: 'delivered', target: 'T', turn: { state: 'failed', exitCode: 3 } } })
snapshot.recent.push({ seq: 4, from: 'dsh', to: 'codex', body: 'unknown turn', delivery: { state: 'delivered', target: 'T', turn: null } })
snapshot.recent.push({ seq: 3, from: 'dsh', to: 'codex', body: 'running turn', delivery: { state: 'delivered', target: 'T', turn: { state: 'running', at: new Date(Date.now() - 125000).toISOString() } } })
const online = await renderPanel({ fetchImpl: async (url) => {
  if (String(url).includes('/status')) return { ok: true, json: async () => snapshot }
  return { ok: true, json: async () => ({ ok: true }) }
} })
ok('renders the online state', online.text.includes('总线在线'), online.text.slice(0, 80))
ok('renders peer cursors', online.text.includes('dsh') && online.text.includes('读至 seq 7'))
ok('renders the unread pill', online.text.includes('1 未读'))
ok('renders a message body', online.text.includes('do the thing'))
// A lease and a delivery are different promises; the panel must not print one word for both.
ok('shows a delivery as 已投', online.text.includes('已投 thread-1'))
ok('completed means this turn ended', online.text.includes('本轮结束') && !online.text.includes('已处理'))
ok('failed turn is separate from delivery', online.text.includes('执行失败') && online.text.includes('failed turn'))
ok('missing turn is unknown', online.text.includes('未知'))
ok('running turn is visible', online.text.includes('运行中'))
ok('running turn shows elapsed minutes', online.text.includes('运行中 · 2m'))
ok('shows a live claim as 在途 with its remaining lease', online.text.includes('在途 codex · 租约剩 42s'))
ok('renders a codex thread', online.text.includes('fix the bus'))
ok('renders the lane', online.text.includes('codex @ thread-1'))
ok('renders the project folder name', online.text.includes('按项目') && online.text.includes('proj'))
ok('shows a project id and its unread count', online.text.includes('#abc12345') && online.text.includes('3 未读'))
ok('hides the unread pill for a caught-up project', online.text.includes('#def67890') && !online.text.includes('0 未读'))
ok('filters malformed array members', !online.text.includes('undefined'), online.text.slice(0, 160))
ok('pings the bus on mount', online.requests.some((r) => String(r.url).includes('/panel/ping?session=session-abc')))

const failed = await renderPanel({ fetchImpl: async (url) => {
  if (String(url).includes('/status')) return { ok: true, json: async () => ({ ok: false, error: 'boom' }) }
  return { ok: true, json: async () => ({ ok: true }) }
} })
ok('shows ok:false as an error, not as online', failed.text.includes('总线未响应') && failed.text.includes('boom'))

const offline = await renderPanel({ fetchImpl: async () => { throw new Error('Failed to fetch') } })
ok('shows a transport failure', offline.text.includes('总线未响应') && offline.text.includes('Failed to fetch'))

// Interact with the real list component; time is fixed for exact duration labels.
const fixedNow = Date.UTC(2026, 10, 18, 8, 0, 0)
const startTime = new Date(fixedNow - 192000).toISOString()
const endTime = new Date(fixedNow).toISOString()
const completeBody = 'first line\nsecond line\n' + 'x'.repeat(400) + '\nFULL TAIL'
const rich = structuredClone(snapshot)
rich.recent = [
  { seq: 7, from: 'dsh', to: 'codex', body: completeBody.slice(0, 240), delivery: { state: 'delivered', target: 'T', turn: { state: 'completed', startedAt: startTime, at: endTime, exitCode: 0, usage: { input_tokens: 18015674, cached_input_tokens: 63700, output_tokens: 131, reasoning_output_tokens: 32 } } } },
  { seq: 6, from: 'dsh', to: 'codex', body: 'second preview', delivery: { state: 'delivered', target: 'T', turn: { state: 'running', at: startTime } } },
  { seq: 5, from: 'dsh', to: 'codex', body: 'failure preview', delivery: { state: 'delivered', target: 'T', turn: { state: 'failed', startedAt: startTime, at: endTime, exitCode: 1 } } },
  { seq: 4, from: 'dsh', to: 'codex', body: 'timeout preview', delivery: { state: 'delivered', target: 'T', turn: { state: 'failed', startedAt: startTime, at: endTime, note: 'timeout', exitCode: 1 } } },
  { seq: 3, from: 'dsh', to: 'codex', body: 'legacy preview', delivery: { state: 'delivered', target: 'T', turn: { state: 'completed', at: endTime, exitCode: 0, usage: { input_tokens: 999 } } } },
]
const nodes = (node, predicate, out = []) => { if (!node || typeof node !== 'object') return out; if (predicate(node)) out.push(node); for (const ch of node.children || []) nodes(ch, predicate, out); return out }
const rows = tree => nodes(tree, n => n.props?.role === 'button')
const row = (ui, seq) => rows(ui.render()).find(n => n.props['data-seq'] === seq)
const click = (ui, seq) => nodes(row(ui, seq), n => typeof n.props?.onClick === 'function')[0].props.onClick()
const key = (ui, seq, name) => row(ui, seq).props.onKeyDown({ key: name, preventDefault() {} })
const response = body => ({ ok: true, json: async () => body })
const ui = await renderPanel({ now: fixedNow, fetchImpl: async url => {
  if (String(url).includes('/status')) return response(rich)
  if (String(url).includes('/message')) {
    const seq = Number(new URL(String(url)).searchParams.get('seq'))
    if (seq === 5) return { ok: false, status: 500 }
    return response({ ok: true, message: { seq, body: seq === 7 ? completeBody : 'second\nfull body' } })
  }
  return response({ ok: true })
} })
ok('terminal duration and usage are formatted', ui.text.includes('本轮结束 · 3m12s · exit 0 · in 18.0M · cached 63.7k · out 131 · reason 32'))
ok('running duration includes seconds', ui.text.includes('运行中 · 3m12s'))
ok('failed duration includes exit code', ui.text.includes('执行失败 · 3m12s · exit 1'))
ok('timeout label includes duration without implying business success', ui.text.includes('执行失败 · 超时 · 3m12s') && !ui.text.includes('已处理'))
ok('legacy completion has no invented duration or usage', !flatten(row(ui, 3)).join(' ').includes('exit 0') && !flatten(row(ui, 3)).join(' ').includes('999'))
ok('collapsed preview is 200 characters and accessible', row(ui, 7).props.tabIndex === 0 && row(ui, 7).props['aria-expanded'] === false && nodes(row(ui, 7), n => n.props?.style?.whiteSpace === 'nowrap' && typeof n.children?.[0] === 'string' && n.children[0].length === 200).length === 1 && !ui.text.includes('FULL TAIL'))
ok('full message is not loaded until expansion', !ui.requests.some(r => String(r.url).includes('/message')))
click(ui, 7); await ui.settle()
ok('first title click expands with aria-expanded', row(ui, 7).props['aria-expanded'] === true)
ok('full body preserves newlines and tail beyond status preview', nodes(row(ui, 7), n => n.children?.includes(completeBody)).length === 1)
ok('expanded body has bounded scrolling and pre-wrap', nodes(row(ui, 7), n => n.props?.style?.whiteSpace === 'pre-wrap' && n.props.style.maxHeight === 480 && n.props.style.overflowY === 'auto').length === 1)
click(ui, 7); ui.render()
ok('second title click collapses', row(ui, 7).props['aria-expanded'] === false)
click(ui, 7); await ui.settle()
ok('reopening uses the seq cache', ui.requests.filter(r => String(r.url).includes('/message?seq=7')).length === 1)
key(ui, 7, 'Escape'); ui.render()
ok('Escape collapses', row(ui, 7).props['aria-expanded'] === false)
key(ui, 7, 'Enter'); await ui.settle()
ok('Enter expands', row(ui, 7).props['aria-expanded'] === true)
key(ui, 6, ' '); await ui.settle()
ok('Space expands another row and collapses the previous row', rows(ui.render()).filter(n => n.props['aria-expanded']).length === 1 && row(ui, 6).props['aria-expanded'] === true)
click(ui, 5); await ui.settle()
ok('lazy load failure is confined to expanded row', flatten(row(ui, 5)).join(' ').includes('读取全文失败：HTTP 500') && !flatten(row(ui, 7)).join(' ').includes('读取全文失败'))
ok('panel only performs read requests and never ack', ui.requests.every(r => !String(r.url).includes('/ack') && (!r.init?.method || r.init.method === 'GET')))
ui.unmount()

const missingUsage = structuredClone(rich)
missingUsage.recent[0].delivery.turn.usage = { input_tokens: 999 }
const compact = await renderPanel({ now: fixedNow, fetchImpl: async () => response(missingUsage) })
ok('small usage is exact and missing usage fields are omitted', compact.text.includes('in 999') && !compact.text.includes('cached ') && !compact.text.includes('reason '))
compact.unmount()

let resolveLate, lateSignal
const delayed = await renderPanel({ now: fixedNow, fetchImpl: (url, init) => {
  if (String(url).includes('/message')) { lateSignal = init.signal; return new Promise(resolve => { resolveLate = resolve }) }
  return Promise.resolve(response(String(url).includes('/status') ? rich : { ok: true }))
} })
click(delayed, 7); delayed.render(); click(delayed, 7); delayed.render()
ok('collapse aborts the in-flight full message request', lateSignal.aborted)
resolveLate(response({ ok: true, message: { seq: 7, body: 'LATE RESPONSE' } })); await delayed.settle()
ok('late response after collapse is ignored', !delayed.text.includes('LATE RESPONSE'))
click(delayed, 7); delayed.render(); delayed.timeOut(); await delayed.settle()
ok('four second timeout aborts and displays row error', lateSignal.aborted && delayed.text.includes('读取全文超时'))
key(delayed, 7, 'Escape'); delayed.render(); click(delayed, 7); delayed.render(); delayed.unmount()
ok('unmount aborts full message request', lateSignal.aborted)

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
