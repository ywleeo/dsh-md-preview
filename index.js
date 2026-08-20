/**
 * dsh-md-preview —— 在 dsh Web 界面里列出并阅读工作区（workspace 目录）中的 Markdown 文件。
 *
 * host-only 插件，模式与 dsh-image-preview 一致（最小、单条 insert、支持 patch 层热加载）：
 *  - 不声明 dsh.bundle（作为普通依赖安装，CLI 不会把它加进 profile bundles 层）；
 *  - 从用户 patch 层（cordis.patch.yml）挂载；
 *  - 通过 webServer 注册若干同源路由，用持久化随机 token 门控，客户端从
 *    index.html 的 <meta> 标签读取 token（webServer.tapIndex 注入）。
 *
 * 工作方式：
 *  1. /workspaces   列出已注册工作区（workspaceRegistry.list()）的目录与标题。
 *  2. /list         递归列出某工作区目录下的 *.md / *.markdown 文件（跳过
 *                   node_modules/.git/隐藏目录，限深 6 层、限 2000 个文件）。
 *  3. /read         返回单个 md 文件的 UTF-8 原文（上限 1MB）。
 *  4. /open         用系统默认应用打开本地 md 文件（detached），再 302 到 /read。
 *
 * 安全边界：/list 与 /read 只接受「已注册工作区目录之下」的路径（fs.contains 校验），
 * 并校验持久化 token —— 与 dsh-image-preview 相同的本地工具信任模型。
 */

export const name = 'dsh-md-preview'

/**
 * 硬依赖：webServer 与 fs 是路由/读文件的前提，声明 inject 让 loader 按依赖顺序挂载。
 * workspaceRegistry 保持可选（ctx.get 探测）：缺省时退化为进程 cwd。
 */
export const inject = ['webServer', 'fs']

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

const BASE_PATH = '/plugins/dsh-md-preview'
const WORKSAPCES_PATH = BASE_PATH + '/workspaces'
const LIST_PATH = BASE_PATH + '/list'
const READ_PATH = BASE_PATH + '/read'
const OPEN_PATH = BASE_PATH + '/open'

const MD_EXT_RE = /\.(md|markdown)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.venv', '__pycache__'])
const MAX_DEPTH = 6
const MAX_FILES = 2000
const MAX_READ_BYTES = 1024 * 1024

/**
 * 持久化 token：写入 $DSH_HOME/plugins/dsh-md-preview.token（600 权限）。
 * 与 dsh-image-preview 相同 —— 跨重启有效，避免页面刷新后 token 失效。
 */
function loadOrCreateToken() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const file = join(home, 'plugins', 'dsh-md-preview.token')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
    const fresh = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(file, fresh, { mode: 0o600 })
    return fresh
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  }
}

/** 解析 query 字符串（兼容 + 号与 percent-encoding）。 */
function parseQuery(rawUrl) {
  const query = {}
  const at = String(rawUrl ?? '').indexOf('?')
  if (at === -1) return query
  for (const pair of String(rawUrl).slice(at + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    try { query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) } catch { /* skip */ }
  }
  return query
}

/** 校验请求 token。 */
function authorized(query, token) {
  return typeof query.t === 'string' && query.t.length > 0 && query.t === token
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, contentType, text) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 全部已注册工作区目录（含进程 cwd 兜底）。 */
async function workspaceRoots(ctx, fs) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      const items = registry.list()
      const roots = []
      for (const item of items) {
        const path = typeof item?.path === 'string' ? item.path : undefined
        if (path !== undefined && path !== '') roots.push(path)
      }
      if (roots.length > 0) return roots
    } catch (error) {
      console.error('[dsh-md-preview] workspaceRegistry.list 失败:', error)
    }
  }
  const cwd = process.cwd()
  return cwd === undefined || cwd === '' ? [] : [cwd]
}

/** 判断 path 是否落在任一已注册工作区根目录之下。 */
async function withinWorkspace(fs, roots, target) {
  for (const root of roots) {
    try {
      const rootTarget = await fs.resolve(root)
      if (fs.contains(rootTarget, target)) return root
    } catch { /* 根目录不可解析则跳过 */ }
  }
  return undefined
}

/** 递归收集目录下的 md 文件（跳过 node_modules/.git/隐藏目录）。 */
async function collectMarkdown(fs, dirTarget, rootPath, files, depth) {
  if (files.length >= MAX_FILES) return
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await fs.listDir(dirTarget)
  } catch {
    return
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return
    const name = entry.name
    if (entry.type === 'directory') {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      await collectMarkdown(fs, entry.target, rootPath, files, depth + 1)
    } else if (entry.type === 'file' && MD_EXT_RE.test(name)) {
      const full = fs.processPath(entry.target)
      files.push({
        path: full,
        name,
        rel: relative(rootPath, full).split(sep).join('/'),
        size: typeof entry.size === 'number' ? entry.size : undefined,
      })
    }
  }
}

/** /workspaces：列出已注册工作区。 */
async function handleWorkspaces(req, res, ctx, fs, token) {
  const query = parseQuery(req.url)
  if (!authorized(query, token)) {
    sendJson(res, 400, { error: 'bad request' })
    return
  }
  const registry = ctx.get('workspaceRegistry')
  const workspaces = []
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const item of registry.list()) {
        const path = typeof item?.path === 'string' ? item.path : undefined
        if (path === undefined || path === '') continue
        workspaces.push({ path, title: typeof item?.title === 'string' && item.title !== '' ? item.title : path })
      }
    } catch (error) {
      console.error('[dsh-md-preview] workspaceRegistry.list 失败:', error)
    }
  }
  if (workspaces.length === 0) {
    const cwd = process.cwd()
    if (cwd !== undefined && cwd !== '') workspaces.push({ path: cwd, title: cwd })
  }
  sendJson(res, 200, { workspaces })
}

/** /list：递归列出某目录下的 md 文件。 */
async function handleList(req, res, ctx, fs, token) {
  const query = parseQuery(req.url)
  if (!authorized(query, token) || !query.p) {
    sendJson(res, 400, { error: 'bad request' })
    return
  }
  try {
    const dirTarget = await fs.resolve(query.p)
    const roots = await workspaceRoots(ctx, fs)
    const rootPath = await withinWorkspace(fs, roots, dirTarget)
    if (rootPath === undefined) {
      sendJson(res, 403, { error: 'not a workspace directory' })
      return
    }
    const files = []
    await collectMarkdown(fs, dirTarget, rootPath, files, 0)
    files.sort((a, b) => a.rel.localeCompare(b.rel))
    sendJson(res, 200, { root: rootPath, files, truncated: files.length >= MAX_FILES })
  } catch (error) {
    sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** /read：返回单个 md 文件原文。 */
async function handleRead(req, res, ctx, fs, token) {
  const query = parseQuery(req.url)
  if (!authorized(query, token) || !query.p || !MD_EXT_RE.test(query.p)) {
    sendText(res, 400, 'text/plain; charset=utf-8', 'bad request')
    return
  }
  try {
    const target = await fs.resolve(query.p)
    const roots = await workspaceRoots(ctx, fs)
    const rootPath = await withinWorkspace(fs, roots, target)
    if (rootPath === undefined) {
      sendText(res, 403, 'text/plain; charset=utf-8', 'not a workspace file')
      return
    }
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') {
      sendText(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    if (typeof info.size === 'number' && info.size > MAX_READ_BYTES) {
      sendText(res, 413, 'text/plain; charset=utf-8', 'file too large')
      return
    }
    const text = await fs.readText(target)
    sendText(res, 200, 'text/markdown; charset=utf-8', text)
  } catch (error) {
    sendText(res, 404, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error))
  }
}

/** 用系统默认应用打开本地文件（detached，不阻塞请求）。 */
function openWithLocalApp(absPath) {
  const platform = process.platform
  let command
  let args
  if (platform === 'darwin') {
    command = 'open'; args = [absPath]
  } else if (platform === 'win32') {
    command = process.env.COMSPEC || 'cmd.exe'; args = ['/c', 'start', '', absPath]
  } else {
    command = 'xdg-open'; args = [absPath]
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[dsh-md-preview] 本地打开失败:', error)
  }
}

/** /open：校验后交给系统默认应用打开，再 302 到 /read。 */
async function handleOpen(req, res, ctx, fs, token) {
  const query = parseQuery(req.url)
  if (!authorized(query, token) || !query.p || !MD_EXT_RE.test(query.p)) {
    res.writeHead(400); res.end('bad request'); return
  }
  try {
    const target = await fs.resolve(query.p)
    const roots = await workspaceRoots(ctx, fs)
    const rootPath = await withinWorkspace(fs, roots, target)
    if (rootPath === undefined) {
      res.writeHead(403); res.end('not a workspace file'); return
    }
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') {
      res.writeHead(404); res.end('not found'); return
    }
    openWithLocalApp(fs.processPath(target))
    res.writeHead(302, { Location: READ_PATH + '?t=' + token + '&p=' + encodeURIComponent(query.p) })
    res.end()
  } catch {
    res.writeHead(404); res.end('not found')
  }
}

/**
 * 插件入口。注册路由 + 在 index.html 注入 <meta>（客户端读取 token 与路由前缀）。
 * 所有依赖经 ctx.get 探测，缺失时静默跳过，绝不阻塞挂载。
 */
export function apply(ctx) {
  const fs = ctx.get('fs')
  const webServer = ctx.get('webServer')
  if (fs === undefined || webServer === undefined) {
    console.warn('[dsh-md-preview] fs/webServer 服务不可用，跳过挂载')
    return
  }
  const token = loadOrCreateToken()

  // 注入 <meta>：客户端在 apply 时读取 token 与路由前缀。
  ctx.effect(() => webServer.tapIndex((html) => {
    const meta = '<meta name="dsh-md-preview-token" content="' + token + '">'
      + '<meta name="dsh-md-preview-base" content="' + BASE_PATH + '">'
    if (html.includes('</head>')) return html.replace('</head>', meta + '</head>')
    return html + meta
  }), 'dsh-md-preview: index meta tap')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: WORKSAPCES_PATH,
    handler: (req, res) => void handleWorkspaces(req, res, ctx, fs, token),
  }), 'dsh-md-preview: workspaces route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: LIST_PATH,
    handler: (req, res) => void handleList(req, res, ctx, fs, token),
  }), 'dsh-md-preview: list route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: READ_PATH,
    handler: (req, res) => void handleRead(req, res, ctx, fs, token),
  }), 'dsh-md-preview: read route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: (req, res) => void handleOpen(req, res, ctx, fs, token),
  }), 'dsh-md-preview: open route')
}
