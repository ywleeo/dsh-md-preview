/**
 * dsh-md-preview 客户端模块（纯 DOM，无 React、无 slots、无外部依赖）。
 *
 * 职责：
 *  1. 右下角悬浮按钮，点击展开/收起预览面板；
 *  2. 面板左侧列出所选工作区下的 .md 文件（按目录分组），右侧渲染文件内容；
 *  3. 通过 host 的同源路由读取数据：/workspaces、/list、/read、/open，
 *     token 从 index.html 的 <meta> 标签读取（由宿主 tapIndex 注入）。
 *
 * 样式全部使用 DSH 设计 token（--dsw-alias-* / --dsw-static-*，带兜底值），
 * 自动跟随应用明暗主题，无需自建主题分支。
 *
 * 无宿主侧插件时降级：meta 缺失 → 面板显示提示，功能静默关闭。
 *
 * dsh 的 client-modules 加载器用普通 <script> 标签拉取本文件，必须调用
 * window.__ModuleLoader__.load({ id, factory }) 完成注册（见
 * @deepseek-ai/dsh 的 packages/client/modules/src/client/system.ts），
 * 因此本文件不能用 ESM export/import，全部自包含。
 */
window.__ModuleLoader__.load({
  id: 'dsh-md-preview',
  factory: function () {
    var META_TOKEN = 'dsh-md-preview-token'
    var META_BASE = 'dsh-md-preview-base'
    var LS_WORKSPACE = 'dsh-md-preview.workspace'

    // ---------- 内联 SVG 图标（currentColor 跟随文字色） ----------

    // Markdown 官方风格图标（M↓ 徽章），用于侧边栏触发按钮与面板标题
    var ICON_MD = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7.5 15.5V8.5l3 3.5 3-3.5v7"/><path d="M16.5 8.5v3.5"/><path d="M15 10.5l1.5 1.5 1.5-1.5"/></svg>'
    var ICON_FOLDER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
    var ICON_CHEVRON = '<svg class="mdp-chev" viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M3.2 5.5 12.8 5.5 8 10.8z"/></svg>'
    var ICON_FILE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
    var ICON_REFRESH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
    var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    // 「打开」：圆角方框 18/24 + 右上斜出箭头（与刷新的环形 18/24 实测等大：均绘制 11.3px）
    var ICON_OPEN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M9.5 14.5 14.5 9.5"/><path d="M10.5 9.5h4v4"/></svg>'
    var ICON_DOC = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>'
    var ICON_EMPTY = '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'

    function apply(ctx) {
      if (typeof document === 'undefined') return
      var state = { token: null, base: null, workspaces: [], current: null, files: [], selected: null, collapsedDirs: {} }

      function readMeta() {
        var t = document.querySelector('meta[name="' + META_TOKEN + '"]')
        var b = document.querySelector('meta[name="' + META_BASE + '"]')
        state.token = t !== null ? t.getAttribute('content') : null
        state.base = b !== null ? b.getAttribute('content') : '/plugins/dsh-md-preview'
      }

      function apiUrl(path, params) {
        var url = state.base + path + '?t=' + encodeURIComponent(state.token || '')
        for (var key in params) {
          if (Object.prototype.hasOwnProperty.call(params, key)) {
            url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key])
          }
        }
        return url
      }

      function apiJson(path, params) {
        return fetch(apiUrl(path, params)).then(function (res) {
          if (!res.ok) {
            return res.text().then(function (text) { throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200)) })
          }
          return res.json()
        })
      }

      // ---------- DOM ----------

      var style = document.createElement('style')
      style.textContent = [
        '/* ===== dsh-md-preview ===== */',
        /* 侧边栏 workspace 行内的触发按钮（注入到行操作区） */
        '.mdp-ws-btn {',
        '  display: inline-flex; align-items: center; justify-content: center;',
        '  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px; cursor: pointer;',
        '  background: none; color: var(--dsw-alias-label-tertiary, #6b7280);',
        '  transition: background .12s ease, color .12s ease;',
        '}',
        '.mdp-ws-btn:hover {',
        '  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));',
        '  color: var(--dsw-static-deepseek-500, #4176e6);',
        '}',

        '#dsh-md-preview-panel {',
        '  position: fixed; top: 16px; right: 16px; bottom: 16px; z-index: 2147482999;',
        '  width: min(920px, calc(100vw - 32px)); display: none; flex-direction: column;',
        '  border-radius: 14px; overflow: hidden;',
        '  background: var(--dsw-alias-bg-layer-2, #fff);',
        '  color: var(--dsw-alias-label-primary, #1f2328);',
        '  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));',
        '  box-shadow: 0 16px 48px rgba(0,0,0,.18);',
        '  font-family: var(--dsw-font-family, system-ui);',
        '  font-size: 14px; line-height: 1.6;',
        '}',
        '#dsh-md-preview-panel[data-open="1"] { display: flex; animation: mdp-panel-in .18s ease; }',
        '@keyframes mdp-panel-in {',
        '  from { opacity: 0; transform: translateY(8px) scale(.985); }',
        '  to { opacity: 1; transform: none; }',
        '}',

        '#dsh-md-preview-panel .mdp-header {',
        '  display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex: none;',
        '  background: var(--dsw-alias-bg-layer-1, #fafafa);',
        '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));',
        '}',
        '#dsh-md-preview-panel .mdp-header-icon {',
        '  display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;',
        '  border-radius: 8px; color: #fff; flex: none;',
        '  background: var(--dsw-static-deepseek-500, #4176e6);',
        '}',
        '#dsh-md-preview-panel .mdp-title { font-size: 14px; font-weight: 600; white-space: nowrap; flex: none; }',
        '#dsh-md-preview-panel .mdp-path {',
        '  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 4px;',
        '  font-size: 12px; overflow: hidden; white-space: nowrap;',
        '}',
        '#dsh-md-preview-panel .mdp-path-dir { color: var(--dsw-alias-label-caption, #9ca3af); overflow: hidden; text-overflow: ellipsis; }',
        '#dsh-md-preview-panel .mdp-path-file { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; flex: none; }',
        '#dsh-md-preview-panel .mdp-path-placeholder { color: var(--dsw-alias-label-caption, #9ca3af); }',
        '#dsh-md-preview-panel .mdp-workspaces-wrap { position: relative; flex: none; min-width: 150px; max-width: 220px; }',
        '#dsh-md-preview-panel select.mdp-workspaces {',
        '  width: 100%; appearance: none; -webkit-appearance: none;',
        '  padding: 5px 28px 5px 10px; border-radius: 8px;',
        '  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));',
        '  background: var(--dsw-alias-bg-layer-3, #fff);',
        '  color: var(--dsw-alias-label-primary, #1f2328);',
        '  font-size: 13px; font-family: inherit; cursor: pointer;',
        '  outline: none;',
        '}',
        '#dsh-md-preview-panel select.mdp-workspaces:focus {',
        '  border-color: var(--dsw-static-deepseek-500, #4176e6);',
        '  box-shadow: 0 0 0 2px var(--dsw-static-deepseek-100, rgba(65,118,230,.18));',
        '}',
        '#dsh-md-preview-panel .mdp-workspaces-wrap::after {',
        '  content: ""; position: absolute; right: 10px; top: 50%; width: 7px; height: 7px;',
        '  border-right: 1.5px solid var(--dsw-alias-label-tertiary, #6b7280);',
        '  border-bottom: 1.5px solid var(--dsw-alias-label-tertiary, #6b7280);',
        '  transform: translateY(-70%) rotate(45deg); pointer-events: none;',
        '}',
        '#dsh-md-preview-panel .mdp-btn {',
        '  display: inline-flex; align-items: center; gap: 5px; flex: none;',
        '  border: none; background: none; cursor: pointer; padding: 5px 9px; border-radius: 8px;',
        '  color: var(--dsw-alias-label-secondary, #4b5563); font-size: 13px; font-family: inherit;',
        '  transition: background .12s ease, color .12s ease;',
        '}',
        '#dsh-md-preview-panel .mdp-btn:hover {',
        '  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));',
        '  color: var(--dsw-alias-label-primary, #1f2328);',
        '}',
        '#dsh-md-preview-panel .mdp-btn.mdp-close { padding: 5px 7px; }',

        '#dsh-md-preview-panel .mdp-body { flex: 1; display: flex; min-height: 0; }',
        '#dsh-md-preview-panel .mdp-files {',
        '  width: 240px; flex: none; overflow-y: auto;',
        '  background: var(--dsw-specific-sidebar-fill, #f8f9fb);',
        '  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));',
        '  padding: 6px 0 10px;',
        '}',
        '#dsh-md-preview-panel .mdp-files::-webkit-scrollbar, #dsh-md-preview-panel .mdp-reader::-webkit-scrollbar { width: 8px; }',
        '#dsh-md-preview-panel .mdp-files::-webkit-scrollbar-thumb, #dsh-md-preview-panel .mdp-reader::-webkit-scrollbar-thumb {',
        '  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.18)); border-radius: 4px;',
        '}',
        '#dsh-md-preview-panel .mdp-files::-webkit-scrollbar-thumb:hover, #dsh-md-preview-panel .mdp-reader::-webkit-scrollbar-thumb:hover {',
        '  background: var(--dsw-alias-scrollbar-hover-l2, rgba(0,0,0,.3));',
        '}',
        '#dsh-md-preview-panel .mdp-tree-dir {',
        '  display: flex; align-items: center; gap: 5px; margin: 1px 8px;',
        '  padding: 5px 8px; border: none; border-radius: 8px; cursor: pointer;',
        '  background: none; color: var(--dsw-alias-label-primary, #1f2328);',
        '  font-size: 13px; font-weight: 500; font-family: inherit; text-align: left;',
        '  width: calc(100% - 16px); user-select: none; transition: background .1s ease;',
        '}',
        '#dsh-md-preview-panel .mdp-tree-dir:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }',
        '#dsh-md-preview-panel .mdp-tree-dir .mdp-chev {',
        '  flex: none; color: var(--dsw-alias-label-tertiary, #6b7280);',
        '  transition: transform .12s ease;',
        '}',
        '#dsh-md-preview-panel .mdp-tree-dir[data-open="0"] .mdp-chev { transform: rotate(-90deg); }',
        '#dsh-md-preview-panel .mdp-tree-dir .mdp-folder-ic { flex: none; color: var(--dsw-static-deepseek-400, #6c93e8); }',
        '#dsh-md-preview-panel .mdp-tree-dir .mdp-dir-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '#dsh-md-preview-panel .mdp-tree-dir .mdp-dir-count {',
        '  margin-left: auto; flex: none; font-size: 11px; font-weight: 400;',
        '  color: var(--dsw-alias-label-tertiary, #6b7280);',
        '}',
        '#dsh-md-preview-panel .mdp-file {',
        '  display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); margin: 1px 8px;',
        '  text-align: left; padding: 5px 8px; border: none; border-radius: 8px; cursor: pointer;',
        '  background: none; color: var(--dsw-alias-label-primary, #1f2328);',
        '  font-size: 13px; font-family: inherit; transition: background .1s ease;',
        '}',
        '#dsh-md-preview-panel .mdp-file svg { flex: none; color: var(--dsw-alias-label-tertiary, #6b7280); }',
        '#dsh-md-preview-panel .mdp-file:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }',
        '#dsh-md-preview-panel .mdp-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '#dsh-md-preview-panel .mdp-file[data-active="1"] {',
        '  background: var(--dsw-alias-interactive-bg-hover-accent, rgba(65,118,230,.12));',
        '  color: var(--dsw-static-deepseek-600, #3460b8);',
        '}',
        '#dsh-md-preview-panel .mdp-file[data-active="1"] svg { color: var(--dsw-static-deepseek-500, #4176e6); }',

        '#dsh-md-preview-panel .mdp-empty {',
        '  display: flex; flex-direction: column; align-items: center; justify-content: center;',
        '  gap: 10px; height: 100%; padding: 24px; text-align: center;',
        '  color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 13px;',
        '}',
        '#dsh-md-preview-panel .mdp-empty svg { opacity: .45; }',

        '#dsh-md-preview-panel .mdp-reader { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 32px; }',
        '#dsh-md-preview-panel .mdp-btn.mdp-open-btn { text-decoration: none; }',
        '#dsh-md-preview-panel .mdp-btn.mdp-open-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }',
        '#dsh-md-preview-panel .mdp-btn.mdp-open-btn[data-disabled="1"] {',
        '  color: var(--dsw-alias-label-caption, #9ca3af); pointer-events: none;',
        '}',

        /* ===== Markdown 排版 ===== */
        '#dsh-md-preview-panel .mdp-markdown { word-wrap: break-word; color: var(--dsw-alias-label-primary, #1f2328); }',
        '#dsh-md-preview-panel .mdp-markdown h1, #dsh-md-preview-panel .mdp-markdown h2,',
        '#dsh-md-preview-panel .mdp-markdown h3, #dsh-md-preview-panel .mdp-markdown h4 {',
        '  margin: 22px 0 10px; line-height: 1.35; font-weight: 600;',
        '}',
        '#dsh-md-preview-panel .mdp-markdown h1:first-child { margin-top: 4px; }',
        '#dsh-md-preview-panel .mdp-markdown h1 { font-size: 23px; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }',
        '#dsh-md-preview-panel .mdp-markdown h2 { font-size: 19px; }',
        '#dsh-md-preview-panel .mdp-markdown h3 { font-size: 16px; }',
        '#dsh-md-preview-panel .mdp-markdown h4 { font-size: 14px; }',
        '#dsh-md-preview-panel .mdp-markdown p { margin: 9px 0; }',
        '#dsh-md-preview-panel .mdp-markdown ul, #dsh-md-preview-panel .mdp-markdown ol { margin: 9px 0; padding-left: 26px; }',
        '#dsh-md-preview-panel .mdp-markdown li { margin: 4px 0; }',
        '#dsh-md-preview-panel .mdp-markdown li::marker { color: var(--dsw-alias-label-tertiary, #6b7280); }',
        '#dsh-md-preview-panel .mdp-markdown blockquote {',
        '  margin: 12px 0; padding: 8px 16px; border-left: 3px solid var(--dsw-static-deepseek-500, #4176e6);',
        '  background: rgba(65, 118, 230, 0.10);',
        '  color: var(--dsw-alias-label-primary, #1f2328); border-radius: 0 8px 8px 0;',
        '}',
        '#dsh-md-preview-panel .mdp-markdown blockquote p { margin: 4px 0; }',
        '#dsh-md-preview-panel .mdp-codeblock { margin: 14px 0; border-radius: 10px; overflow: hidden;',
        '  background: var(--dsw-alias-markdown-code-block, #f6f8fa);',
        '  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));',
        '}',
        '#dsh-md-preview-panel .mdp-codeblock-head {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  padding: 5px 12px; font-size: 11px; font-weight: 500;',
        '  color: var(--dsw-alias-label-tertiary, #6b7280);',
        '  background: var(--dsw-alias-markdown-code-block-banner, #f0f3f7);',
        '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));',
        '}',
        '#dsh-md-preview-panel .mdp-codeblock pre { margin: 0; padding: 12px 14px; overflow-x: auto; }',
        '#dsh-md-preview-panel .mdp-codeblock code {',
        '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
        '  font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-primary, #1f2328);',
        '}',
        '#dsh-md-preview-panel .mdp-markdown p > code, #dsh-md-preview-panel .mdp-markdown li > code,',
        '#dsh-md-preview-panel .mdp-markdown td > code, #dsh-md-preview-panel .mdp-markdown h1 > code,',
        '#dsh-md-preview-panel .mdp-markdown h2 > code, #dsh-md-preview-panel .mdp-markdown h3 > code {',
        '  background: var(--dsw-alias-markdown-inline-code, #f1f5f9);',
        '  color: var(--dsw-static-red-500, #ef4444);',
        '  padding: 1px 6px; border-radius: 5px; font-size: .9em;',
        '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
        '}',
        '#dsh-md-preview-panel .mdp-markdown a { color: var(--dsw-static-deepseek-500, #4176e6); text-decoration: none; }',
        '#dsh-md-preview-panel .mdp-markdown a:hover { text-decoration: underline; }',
        '#dsh-md-preview-panel .mdp-markdown img { max-width: 100%; border-radius: 10px; }',
        '#dsh-md-preview-panel .mdp-markdown hr { border: none; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); margin: 20px 0; }',
        '#dsh-md-preview-panel .mdp-markdown table { border-collapse: collapse; margin: 14px 0; width: 100%; font-size: 13px; }',
        '#dsh-md-preview-panel .mdp-markdown th, #dsh-md-preview-panel .mdp-markdown td {',
        '  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14)); padding: 7px 12px; text-align: left;',
        '}',
        '#dsh-md-preview-panel .mdp-markdown thead th {',
        '  background: var(--dsw-alias-markdown-code-block-banner, #f0f3f7);',
        '  font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328);',
        '}',
        '#dsh-md-preview-panel .mdp-markdown tbody tr:nth-child(even) { background: var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.02)); }',
        '#dsh-md-preview-panel .mdp-markdown del { color: var(--dsw-alias-label-caption, #9ca3af); }',
        /* ===== 深色模式覆盖：静态品牌色在暗色下用更亮的档位 ===== */
        'body[data-ds-dark-theme] #dsh-md-preview-panel .mdp-markdown a,',
        'body[data-ds-dark-theme] #dsh-md-preview-panel .mdp-file[data-active="1"] {',
        '  color: var(--dsw-static-deepseek-400, #679efe);',
        '}',
        'body[data-ds-dark-theme] #dsh-md-preview-panel .mdp-file[data-active="1"] svg { color: var(--dsw-static-deepseek-400, #679efe); }',
      ].join('\n')
      document.head.appendChild(style)

      var panel = document.createElement('div')
      panel.id = 'dsh-md-preview-panel'
      panel.innerHTML = [
        '<div class="mdp-header">',
        '  <span class="mdp-header-icon">' + ICON_MD.replace('width="20"', 'width="15"').replace('height="20"', 'height="15"') + '</span>',
        '  <span class="mdp-title">Markdown 预览</span>',
        '  <span class="mdp-path"><span class="mdp-path-placeholder">未打开文件</span></span>',
        '  <span class="mdp-workspaces-wrap"><select class="mdp-workspaces" title="选择工作区"></select></span>',
        '  <a class="mdp-btn mdp-open-btn" data-disabled="1" title="用系统默认应用打开当前文件">' + ICON_OPEN + '<span>打开</span></a>',
        '  <button type="button" class="mdp-btn mdp-refresh" title="刷新文件列表">' + ICON_REFRESH + '<span>刷新</span></button>',
        '  <button type="button" class="mdp-btn mdp-close" title="关闭 (Esc)">' + ICON_CLOSE + '</button>',
        '</div>',
        '<div class="mdp-body">',
        '  <div class="mdp-files"></div>',
        '  <div class="mdp-reader"></div>',
        '</div>',
      ].join('')

      document.body.appendChild(panel)

      var filesEl = panel.querySelector('.mdp-files')
      var readerEl = panel.querySelector('.mdp-reader')
      var selectEl = panel.querySelector('.mdp-workspaces')
      var refreshBtn = panel.querySelector('.mdp-refresh')
      var openBtn = panel.querySelector('.mdp-open-btn')
      var pathEl = panel.querySelector('.mdp-path')
      openBtn.target = '_blank'
      openBtn.rel = 'noopener'

      /** 顶栏显示当前文件路径（目录弱化 + 文件名加粗），无文件时显示占位。 */
      function setHeaderPath(relPath) {
        if (relPath === null || relPath === '') {
          pathEl.innerHTML = '<span class="mdp-path-placeholder">未打开文件</span>'
          return
        }
        var slash = relPath.lastIndexOf('/')
        var dir = slash === -1 ? '' : relPath.slice(0, slash + 1)
        var name = slash === -1 ? relPath : relPath.slice(slash + 1)
        pathEl.innerHTML = '<span class="mdp-path-dir">' + escapeHtml(dir) + '</span>'
          + '<span class="mdp-path-file">' + escapeHtml(name) + '</span>'
        pathEl.title = relPath
      }

      function setOpen(open) {
        panel.setAttribute('data-open', open ? '1' : '0')
        if (open) loadWorkspaces()
      }

      panel.querySelector('.mdp-close').addEventListener('click', function () { setOpen(false) })
      refreshBtn.addEventListener('click', function () { loadList() })
      selectEl.addEventListener('change', function () {
        state.current = selectEl.value
        try { localStorage.setItem(LS_WORKSPACE, state.current) } catch { /* 隐私模式忽略 */ }
        loadList()
      })
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && panel.getAttribute('data-open') === '1') setOpen(false)
      })

      // ---------- 侧边栏 workspace 行触发按钮 ----------

      var pendingPath = null

      /** 依据 workspace 标题匹配侧边栏行，注入 📖 按钮。 */
      function injectSidebarButtons() {
        if (state.workspaces.length === 0) return
        var rows = document.querySelectorAll('[role="treeitem"][aria-expanded]')
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i]
          if (row.getAttribute('data-mdp-injected') === '1') continue
          var titleEl = row.children && row.children[2]
          var title = titleEl !== undefined ? (titleEl.textContent || '').trim() : ''
          if (title === '') continue
          var ws = null
          for (var j = 0; j < state.workspaces.length; j++) {
            if (state.workspaces[j].title === title) { ws = state.workspaces[j]; break }
          }
          if (ws === null) continue
          var actions = row.children && row.children[3]
          if (actions === undefined) continue
          row.setAttribute('data-mdp-injected', '1')
          var btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'mdp-ws-btn'
          btn.title = '阅读「' + ws.title + '」的 Markdown 文件'
          btn.innerHTML = ICON_MD
          // 闭包捕获当前行的 workspace（var 在循环里是函数作用域，必须用 IIFE 固化）
          ;(function (path) {
            btn.addEventListener('click', function (event) {
              event.stopPropagation()
              openForWorkspace(path)
            })
          })(ws.path)
          actions.insertBefore(btn, actions.firstChild)
        }
      }

      var treeObserver = null
      if (typeof MutationObserver !== 'undefined') {
        treeObserver = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes
            for (var j = 0; j < added.length; j++) {
              var node = added[j]
              if (node.nodeType !== 1 || typeof node.matches !== 'function') continue
              if (node.matches('[role="treeitem"]') || node.querySelector('[role="treeitem"]') !== null) {
                injectSidebarButtons()
                return
              }
            }
          }
        })
        treeObserver.observe(document.body, { childList: true, subtree: true })
      }
      injectSidebarButtons()

      /** 选中指定工作区并打开面板。 */
      function selectWorkspace(path) {
        for (var i = 0; i < selectEl.options.length; i++) {
          if (selectEl.options[i].value === path) { selectEl.selectedIndex = i; break }
        }
        state.current = selectEl.value
        try { localStorage.setItem(LS_WORKSPACE, state.current) } catch { /* ignore */ }
      }

      function openForWorkspace(path) {
        pendingPath = path
        setOpen(true)
        if (selectEl.options.length === 0) {
          loadWorkspaces() // 完成后会选中 pendingPath 并加载列表
        } else {
          selectWorkspace(path)
          loadList()
        }
      }

      // ---------- 数据加载 ----------

      function showFilesMessage(text) {
        filesEl.innerHTML = ''
        var div = document.createElement('div')
        div.className = 'mdp-empty'
        div.innerHTML = ICON_EMPTY + '<span>' + escapeHtml(text) + '</span>'
        filesEl.appendChild(div)
      }

      function showReaderMessage(text) {
        readerEl.innerHTML = ''
        var div = document.createElement('div')
        div.className = 'mdp-empty'
        div.innerHTML = ICON_DOC + '<span>' + escapeHtml(text) + '</span>'
        readerEl.appendChild(div)
      }

      var workspacesLoading = false

      function loadWorkspaces() {
        if (state.token === null || state.token === '') {
          showFilesMessage('插件未加载或 token 缺失，请刷新页面')
          return
        }
        // 防重入：openForWorkspace 与 setOpen 可能同时触发，重复请求会互相覆盖选择
        if (workspacesLoading) return
        workspacesLoading = true
        apiJson('/workspaces').then(function (data) {
          state.workspaces = data.workspaces || []
          selectEl.innerHTML = ''
          for (var i = 0; i < state.workspaces.length; i++) {
            var opt = document.createElement('option')
            opt.value = state.workspaces[i].path
            opt.textContent = state.workspaces[i].title
            selectEl.appendChild(opt)
          }
          // 确定性恢复选中项：pendingPath（侧边栏点击）→ 上次记忆 → 当前值
          var preferred = pendingPath
          if (preferred === null) {
            try { preferred = localStorage.getItem(LS_WORKSPACE) } catch { /* ignore */ }
          }
          if (preferred === null) preferred = state.current
          if (preferred !== null) {
            for (var j = 0; j < selectEl.options.length; j++) {
              if (selectEl.options[j].value === preferred) { selectEl.selectedIndex = j; break }
            }
          }
          // 侧边栏触发按钮依赖 workspace 列表，加载完成后注入
          injectSidebarButtons()
          if (state.workspaces.length === 0) {
            showFilesMessage('没有已注册的工作区，请先在侧边栏添加工作区')
            return
          }
          if (pendingPath !== null) pendingPath = null
          state.current = selectEl.value
          loadList()
        }).catch(function (err) {
          showFilesMessage('加载工作区失败：' + err.message)
        }).finally(function () {
          workspacesLoading = false
        })
      }

      function loadList() {
        if (state.current === null || state.current === '') return
        showFilesMessage('加载中…')
        apiJson('/list', { p: state.current }).then(function (data) {
          state.files = data.files || []
          renderFiles()
          if (state.selected !== null && state.files.some(function (f) { return f.path === state.selected })) {
            openFile(state.selected)
          } else {
            // 无选中文件：重置顶栏路径与「打开」按钮
            state.selected = null
            setHeaderPath(null)
            openBtn.removeAttribute('href')
            openBtn.setAttribute('data-disabled', '1')
            showReaderMessage('从左侧选择文件阅读')
          }
        }).catch(function (err) {
          showFilesMessage('加载文件列表失败：' + err.message)
        })
      }

      /** 由平铺文件列表构建嵌套目录树（根 → 目录 → 子目录 → 文件）。 */
      function buildTree(files) {
        var root = { name: '', path: '', isDir: true, children: [] }
        for (var i = 0; i < files.length; i++) {
          var file = files[i]
          var parts = file.rel.split('/')
          var node = root
          var dirPath = ''
          for (var j = 0; j < parts.length - 1; j++) {
            dirPath = dirPath === '' ? parts[j] : dirPath + '/' + parts[j]
            var child = null
            for (var k = 0; k < node.children.length; k++) {
              if (node.children[k].isDir && node.children[k].name === parts[j]) { child = node.children[k]; break }
            }
            if (child === null) {
              child = { name: parts[j], path: dirPath, isDir: true, children: [] }
              node.children.push(child)
            }
            node = child
          }
          node.children.push({ name: parts[parts.length - 1], path: file.path, isDir: false, size: file.size })
        }
        return root
      }

      /** 目录在前、文件在后，各自按名称排序。 */
      function compareNodes(a, b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      }

      /** 目录子树内 md 文件数量。 */
      function countFiles(node) {
        var n = 0
        for (var i = 0; i < node.children.length; i++) {
          var c = node.children[i]
          n += c.isDir ? countFiles(c) : 1
        }
        return n
      }

      function renderFileRow(node, depth, container) {
        var row = document.createElement('button')
        row.type = 'button'
        row.className = 'mdp-file'
        row.setAttribute('data-path', node.path)
        row.style.paddingLeft = (8 + depth * 16) + 'px'
        row.title = node.path
        row.innerHTML = ICON_FILE + '<span class="mdp-file-name">' + escapeHtml(node.name) + '</span>'
        if (node.path === state.selected) row.setAttribute('data-active', '1')
        ;(function (path) {
          row.addEventListener('click', function () { openFile(path) })
        })(node.path)
        container.appendChild(row)
      }

      function renderDirRow(node, depth, container) {
        var open = !state.collapsedDirs[node.path]
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mdp-tree-dir'
        btn.setAttribute('data-open', open ? '1' : '0')
        btn.style.paddingLeft = (8 + depth * 16) + 'px'
        btn.title = node.path
        btn.innerHTML = ICON_CHEVRON
          + '<span class="mdp-folder-ic">' + ICON_FOLDER + '</span>'
          + '<span class="mdp-dir-name">' + escapeHtml(node.name) + '</span>'
          + '<span class="mdp-dir-count">' + countFiles(node) + '</span>'
        ;(function (path) {
          btn.addEventListener('click', function (event) {
            event.stopPropagation()
            if (state.collapsedDirs[path]) delete state.collapsedDirs[path]
            else state.collapsedDirs[path] = true
            renderFiles()
          })
        })(node.path)
        container.appendChild(btn)
        if (open) renderTreeNode(node, depth + 1, container)
      }

      function renderTreeNode(node, depth, container) {
        var sorted = node.children.slice().sort(compareNodes)
        for (var i = 0; i < sorted.length; i++) {
          var child = sorted[i]
          if (child.isDir) renderDirRow(child, depth, container)
          else renderFileRow(child, depth, container)
        }
      }

      function renderFiles() {
        filesEl.innerHTML = ''
        if (state.files.length === 0) {
          showFilesMessage('没有找到 .md 文件')
          return
        }
        var root = buildTree(state.files)
        renderTreeNode(root, 0, filesEl)
        // 保持当前选中文件可见
        if (state.selected !== null) {
          var active = filesEl.querySelector('.mdp-file[data-active="1"]')
          if (active !== null) active.scrollIntoView({ block: 'nearest' })
        }
      }

      function openFile(path) {
        state.selected = path
        var rows = filesEl.querySelectorAll('.mdp-file')
        for (var i = 0; i < rows.length; i++) {
          rows[i].setAttribute('data-active', rows[i].getAttribute('data-path') === path ? '1' : '0')
        }
        var file = null
        for (var j = 0; j < state.files.length; j++) {
          if (state.files[j].path === path) { file = state.files[j]; break }
        }
        var pathLabel = file !== null ? file.rel : path
        // 顶栏显示当前文件路径
        setHeaderPath(pathLabel)
        // header「打开」按钮：有选中文件时激活
        openBtn.href = apiUrl('/open', { p: path })
        openBtn.setAttribute('data-disabled', '0')
        showReaderMessage('加载中…')
        fetch(apiUrl('/read', { p: path })).then(function (res) {
          if (!res.ok) return res.text().then(function (text) { throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200)) })
          return res.text()
        }).then(function (text) {
          renderReader(text)
        }).catch(function (err) {
          showReaderMessage('读取失败：' + err.message)
        })
      }

      function renderReader(markdown) {
        var body = document.createElement('div')
        body.className = 'mdp-markdown'
        body.innerHTML = renderMarkdown(markdown)
        readerEl.innerHTML = ''
        readerEl.appendChild(body)
      }

      // ---------- 迷你 Markdown 渲染 ----------

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      }

      function safeUrl(raw) {
        var value = String(raw || '').trim()
        var decoded = value.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/')
        if (/^(javascript|data|vbscript):/i.test(decoded)) return ''
        if (/^(https?:|mailto:)/i.test(decoded)) return decoded
        if (decoded.charAt(0) === '#' || decoded.charAt(0) === '/' || decoded.indexOf(':') === -1) return decoded
        return ''
      }

      function inline(text) {
        var out = escapeHtml(text)
        // 行内代码（先处理，避免影响后续标记）
        out = out.replace(/`([^`]+)`/g, function (_, code) { return '<code>' + code + '</code>' })
        // 图片
        out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, alt, url) {
          var href = safeUrl(url)
          if (href === '') return escapeHtml('![' + alt + '](' + url + ')')
          return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '">'
        })
        // 链接
        out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, label, url) {
          var href = safeUrl(url)
          if (href === '') return escapeHtml('[' + label + '](' + url + ')')
          return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
        })
        // 粗体 / 斜体 / 删除线（避免已生成标签内的标记）
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
        return out
      }

      function isTableSep(line) {
        return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf('-') !== -1
      }

      function renderTable(rows) {
        var html = '<table>'
        // 切分表行单元格：去掉首尾的空段（`| a | b |` → [a, b]）
        var splitCells = function (row) {
          var cells = row.split('|')
          if (cells.length > 0 && cells[0].trim() === '') cells.shift()
          if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
          return cells.map(function (c) { return c.trim() })
        }
        var headCells = splitCells(rows[0])
        html += '<thead><tr>' + headCells.map(function (c) { return '<th>' + inline(c) + '</th>' }).join('') + '</tr></thead>'
        html += '<tbody>'
        // rows[0] 是表头，分隔行已被收集阶段跳过，数据行从下标 1 开始
        for (var i = 1; i < rows.length; i++) {
          var cells = splitCells(rows[i])
          html += '<tr>' + cells.map(function (c) { return '<td>' + inline(c) + '</td>' }).join('') + '</tr>'
        }
        html += '</tbody></table>'
        return html
      }

      function renderMarkdown(src) {
        var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
        var html = ''
        var i = 0
        // 块级起始行：段落收集器必须在此停下，否则会把列表项/标题/引用/围栏等
        // 吞进 <p> 里（典型症状：紧跟段落且没有空行的 "- 条目" 变成字面文本，
        // 列表样式与缩进完全丢失）。
        function isBlockStart(line) {
          if (/^\s*(```|~~~)/.test(line)) return true            // 代码围栏
          if (/^\s*#{1,6}\s+/.test(line)) return true            // 标题
          if (/^\s*>\s?/.test(line)) return true                 // 引用
          if (/^\s*[-*+]\s+/.test(line)) return true             // 无序列表项
          if (/^\s*\d+\.\s+/.test(line)) return true             // 有序列表项
          if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return true    // 分隔线
          // 表格（与主循环同一近似：本行含 | 且下一行是分隔行）
          if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) return true
          return false
        }

        // ---- 列表：栈式嵌套 + 多行条目 ----
        var listStack = []   // 栈顶是当前列表 { type: 'ul'|'ol', indent: 条目缩进空格数, liOpen: 当前条目 <li> 是否已打开 }
        function closeLists() {
          while (listStack.length > 0) {
            var top = listStack[listStack.length - 1]
            if (top.liOpen) { html += '</li>'; top.liOpen = false }
            html += '</' + top.type + '>'
            listStack.pop()
          }
        }
        function pushListItem(match) {
          var indent = match[1].length
          var type = /^\d+\.$/.test(match[2]) ? 'ol' : 'ul'
          var top = listStack.length > 0 ? listStack[listStack.length - 1] : null
          // 同级类型切换（ul↔ol）或回到更浅层级：先关掉这些列表（含其中打开的条目）
          while (top !== null && (top.indent > indent || (top.indent === indent && top.type !== type))) {
            if (top.liOpen) { html += '</li>'; top.liOpen = false }
            html += '</' + top.type + '>'
            listStack.pop()
            top = listStack.length > 0 ? listStack[listStack.length - 1] : null
          }
          if (top !== null && top.indent === indent) {
            // 同级继续：关掉上一个条目再开新的
            if (top.liOpen) { html += '</li>'; top.liOpen = false }
            html += '<li>'
            top.liOpen = true
          } else {
            // 进入更深的嵌套（父条目保持打开，嵌套列表在其内部）或开启新列表
            html += '<' + type + '>'
            listStack.push({ type: type, indent: indent, liOpen: false })
            html += '<li>'
            listStack[listStack.length - 1].liOpen = true
          }
          html += inline(match[3])
        }

        while (i < lines.length) {
          var line = lines[i]
          // 代码围栏
          var fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
          if (fence !== null) {
            closeLists()
            var lang = fence[2]
            var code = []
            i += 1
            while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) {
              code.push(lines[i]); i += 1
            }
            i += 1
            html += '<div class="mdp-codeblock">'
              + '<div class="mdp-codeblock-head"><span>' + escapeHtml(lang !== '' ? lang : 'text') + '</span></div>'
              + '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>'
              + '</div>'
            continue
          }
          // 表格
          if (i + 1 < lines.length && isTableSep(lines[i + 1]) && line.indexOf('|') !== -1) {
            closeLists()
            var tableRows = [line]
            i += 2
            while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
              tableRows.push(lines[i]); i += 1
            }
            html += renderTable(tableRows)
            continue
          }
          // 标题
          var heading = /^(#{1,6})\s+(.*)$/.exec(line)
          if (heading !== null) {
            closeLists()
            var level = heading[1].length
            html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>'
            i += 1
            continue
          }
          // 分隔线
          if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
            closeLists()
            html += '<hr>'
            i += 1
            continue
          }
          // 引用
          if (/^\s*>\s?/.test(line)) {
            closeLists()
            var quote = []
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
              quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1
            }
            html += '<blockquote>' + quote.map(function (q) { return '<p>' + inline(q) + '</p>' }).join('') + '</blockquote>'
            continue
          }
          // 列表项（缩进产生嵌套层级；支持 - / * / + 与 1. 2. …）
          var item = /^( *)((?:[-*+])|(?:\d+\.)) +(.*)$/.exec(line)
          if (item !== null) {
            pushListItem(item)
            i += 1
            continue
          }
          // 列表内的续行：比条目更缩进、非块级起始的非空行并入当前条目
          if (listStack.length > 0 && listStack[listStack.length - 1].liOpen && /^\s+\S/.test(line)) {
            html += '<br>' + inline(line.replace(/^\s+/, ''))
            i += 1
            continue
          }
          // 段落
          closeLists()
          if (line.trim() === '') {
            i += 1
            continue
          }
          var para = []
          while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
            para.push(lines[i]); i += 1
          }
          html += '<p>' + para.map(inline).join('<br>') + '</p>'
        }
        closeLists()
        return html
      }

      // 清理：卸载时移除 DOM 与样式，断开侧边栏观察器。
      ctx.effect(function () {
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
          if (panel.parentNode !== null) panel.parentNode.removeChild(panel)
          if (treeObserver !== null) treeObserver.disconnect()
          var injected = document.querySelectorAll('.mdp-ws-btn')
          for (var i = 0; i < injected.length; i++) {
            var parent = injected[i].parentNode
            if (parent !== null) injected[i].parentNode.removeChild(injected[i])
          }
        }
      }, 'dsh-md-preview: ui')

      readMeta()
      // 启动时预取 workspace 列表：侧边栏行按钮依赖它注入
      loadWorkspaces()
    }

    return { name: 'dsh-md-preview', apply: apply }
  },
})
