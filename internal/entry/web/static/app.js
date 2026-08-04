'use strict';
/* ainovel WebUI 前端 —— 单页应用（原生 JS，零依赖）。
 * 与后端约定：
 *   - REST JSON API（/api/...），错误统一 {"error": "..."}；
 *   - 事件/流式输出经 SSE（/api/books/{id}/stream），事件类型 event/delta/clear/done/import/sim/cocreate；
 *   - 状态快照经 GET /api/books/{id}（host.UISnapshot，Go 字段名键）。
 */

// ================= API 客户端 =================

async function api(path, opts = {}) {
  // FormData（文件上传）不手动设 Content-Type：浏览器自动带 multipart boundary。
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { headers, ...opts });
  if (res.status === 401) {
    // 未登录/会话过期：切回登录视图（除登录相关端点外）。
    if (!path.includes('/login') && !path.includes('/auth-status') && !path.includes('/setup-auth')) {
      authInfo.authenticated = false;
      showAuthLogin();
    }
    const err = new Error('未登录或会话已过期');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (_) { /* 非 JSON 错误体 */ }
    const err = new Error(msg || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function postJSON(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body || {}) });
}

// ================= DOM 工具 =================

function $(sel) { return document.querySelector(sel); }

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtCost(n) {
  if (!n) return '$0';
  return '$' + (Math.round(n * 10000) / 10000).toFixed(4);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// ================= 视图切换 =================

const VIEWS = ['shelf', 'workspace', 'setup', 'auth'];
function showView(name) {
  for (const v of VIEWS) {
    const node = $('#view-' + v);
    if (node) node.classList.toggle('hidden', v !== name);
  }
}

// ================= Toast =================

function toast(msg, kind = '') {
  const node = el('div', { class: 'toast ' + kind, text: msg });
  $('#toast-root').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3000);
}

// ================= 模态框 =================

let modalBackdrop = null;

function openModal({ title, body, footer, onMount, onClose, wide }) {
  closeModal();
  const close = () => { if (modalBackdrop) { modalBackdrop.remove(); modalBackdrop = null; } };
  modalBackdrop = el('div', { class: 'modal-backdrop' });
  const m = el('div', { class: 'modal' + (wide ? ' wide' : '') });
  m.append(
    el('div', { class: 'modal-header' },
      el('h3', { text: title || '' }),
      el('button', { class: 'modal-close', type: 'button', text: '✕', onclick: () => close() })
    ),
    el('div', { class: 'modal-body' }, body || '')
  );
  if (footer) m.append(el('div', { class: 'modal-footer' }, footer));
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) close(); });
  modalBackdrop.append(m);
  $('#modal-root').append(modalBackdrop);
  if (onMount) onMount(m);
  return { close, root: m };
}

function closeModal() {
  if (modalBackdrop) { modalBackdrop.remove(); modalBackdrop = null; }
}

// ================= 工具 =================

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

// 滚动区域是否已贴底（用于自动滚动策略）
function isNearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
}

// 简单的日期时间（书架创建时间）
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

// ================= Markdown 渲染 =================

// md 把 markdown 渲染为净化后的 HTML；库缺失时退化为纯文本转义。
function md(text) {
  if (text == null) return '';
  let html = esc(String(text));
  try {
    if (window.marked) html = marked.parse(String(text));
  } catch (_) { /* 解析失败用转义文本 */ }
  try {
    if (window.DOMPurify) html = DOMPurify.sanitize(html);
  } catch (_) { /* sanitize 失败保持现状 */ }
  return html;
}

// ================= 鉴权 =================

let authInfo = { configured: false, authenticated: false, display_name: '' };

async function refreshAuthInfo() {
  try {
    authInfo = await api('/api/auth-status');
  } catch (e) {
    authInfo = { configured: false, authenticated: false, display_name: '' };
  }
}

function renderUserArea() {
  const name = authInfo.display_name || '用户';
  document.querySelectorAll('.user-badge').forEach((el) => { el.textContent = '👤 ' + name; });
}

function showAuthSetup() {
  $('#auth-setup-form').classList.remove('hidden');
  $('#auth-login-form').classList.add('hidden');
  $('#auth-error').classList.add('hidden');
  $('#auth-name').value = '';
  $('#auth-pw').value = '';
  showView('auth');
  $('#auth-name').focus();
}

function showAuthLogin() {
  $('#auth-setup-form').classList.add('hidden');
  $('#auth-login-form').classList.remove('hidden');
  $('#auth-error').classList.add('hidden');
  $('#login-pw').value = '';
  showView('auth');
  $('#login-pw').focus();
}

function showAuthError(msg) {
  const box = $('#auth-error');
  box.textContent = msg;
  box.classList.remove('hidden');
}

// requireAuth 返回是否已通过鉴权；未通过时切到对应鉴权视图。
async function requireAuth() {
  await refreshAuthInfo();
  if (!authInfo.configured) {
    showAuthSetup();
    return false;
  }
  if (!authInfo.authenticated) {
    showAuthLogin();
    return false;
  }
  renderUserArea();
  return true;
}

async function enterApp() {
  await refreshAuthInfo();
  renderUserArea();
  const health = await api('/api/health');
  if (health.setup) {
    showView('setup');
    await bindSetup();
    return;
  }
  showView('shelf');
  await loadBooks();
}

function bindAuth() {
  $('#setup-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await postJSON('/api/setup-auth', {
        display_name: $('#auth-name').value.trim(),
        password: $('#auth-pw').value,
      });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
      btn.disabled = false;
    }
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await postJSON('/api/login', { password: $('#login-pw').value });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
      btn.disabled = false;
    }
  });
  $('#btn-logout').addEventListener('click', async () => {
    try { await postJSON('/api/logout', {}); } catch (_) { /* 忽略 */ }
    authInfo.authenticated = false;
    showAuthLogin();
  });
}

// ================= 全局状态 =================

const state = {
  books: [],
  currentBookId: null,
  snapshot: null,
  events: [],       // 事件流（新→旧？按序追加）
  streamRounds: [], // 输出轮次（clear 分轮）
  streamBuf: '',    // 当前轮累积文本
  streamThinking: '',
  pendingStart: false, // 新建书后引擎启动裁定进行中
};

// ================= 书架 =================

async function loadBooks() {
  const data = await api('/api/books');
  state.books = data.books || [];
  const list = $('#book-list');
  list.innerHTML = '';
  $('#shelf-empty').classList.toggle('hidden', state.books.length > 0);
  for (const b of state.books) {
    const card = el('div', { class: 'book-card', onclick: () => openWorkspace(b.id) },
      el('div', { class: 'title', text: b.title }),
      el('div', { class: 'meta' },
        '创建于 ' + fmtDateTime(b.created_at),
        b.open ? el('div', { class: 'open-badge', text: '● 会话已打开' }) : null
      )
    );
    list.append(card);
  }
}

// 新建书对话框（快速开始 / 共创规划）
function openNewBookModal() {
  const mode = { value: 'quick' };
  const titleInput = el('input', { type: 'text', placeholder: '书名（可留空，默认「未命名小说」）' });
  const promptInput = el('textarea', { rows: 6, placeholder: '描述你的小说需求…\n（快速开始：填写后直接启动 AI 创作）' });
  const hint = el('p', { class: 'muted', text: '快速开始：直接以需求启动创作。共创规划：先与 AI 多轮讨论，再生成创作指令启动。' });

  const body = el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
    el('label', {}, '模式',
      el('div', { style: 'display:flex;gap:16px' },
        el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
          el('input', { type: 'radio', name: 'nb-mode', checked: '', onclick: () => {
            mode.value = 'quick';
            promptInput.placeholder = '描述你的小说需求…（将直接启动创作）';
            hint.textContent = '快速开始：直接以需求启动创作。共创规划：先与 AI 多轮讨论，再生成创作指令启动。';
          } }), ' 快速开始'),
        el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
          el('input', { type: 'radio', name: 'nb-mode', onclick: () => {
            mode.value = 'cocreate';
            promptInput.placeholder = '输入你的初步想法，与 AI 共创完善…';
            hint.textContent = '共创规划：先创建会话，在共创对话框中与 AI 多轮讨论，生成创作指令后启动。';
          } }), ' 共创规划')
      )
    ),
    el('label', { text: '书名' }, titleInput),
    el('label', { text: '创作需求 / 初步想法' }, promptInput),
    hint
  );

  const submitBtn = el('button', { class: 'btn primary', type: 'button', text: '创建' });
  const modal = openModal({
    title: '新建书',
    body,
    footer: [submitBtn],
    onMount: () => submitBtn.focus(),
  });

  submitBtn.addEventListener('click', async () => {
    if (mode.value === 'quick' && !promptInput.value.trim()) {
      toast('请输入创作需求', 'error');
      promptInput.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = mode.value === 'quick' ? '启动中（首次裁定需数秒）…' : '创建会话中…';
    try {
      const res = await postJSON('/api/books', {
        mode: mode.value,
        title: titleInput.value,
        prompt: promptInput.value,
      });
      modal.close();
      state.pendingStart = (mode.value === 'quick');
      if (mode.value === 'cocreate') {
        await openWorkspace(res.book.id);
        openCoCreateModal(true); // 冷启动共创
      } else {
        await openWorkspace(res.book.id);
      }
    } catch (e) {
      toast(e.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = '创建';
    }
  });
}

// 删除当前小说（可保留已完结书）
function openDeleteBookModal() {
  const id = state.currentBookId;
  const keepBox = el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
    el('input', { type: 'checkbox' }), ' 保留已完成的小说（仅从书架移除，不删除文件）');
  const confirmBtn = el('button', { class: 'btn danger', type: 'button', text: '删除' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
  const modal = openModal({
    title: '删除当前小说',
    body: el('div', { class: 'muted', style: 'line-height:1.7' },
      '确定删除这本书吗？删除后其章节与进度不可恢复。', keepBox),
    footer: [cancelBtn, confirmBtn],
  });
  cancelBtn.addEventListener('click', () => modal.close());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '删除中…';
    try {
      const q = keepBox.querySelector('input').checked ? '?keep_completed=1' : '';
      await api('/api/books/' + id + q, { method: 'DELETE' });
      modal.close();
      disconnectStream();
      stopSnapshotPolling();
      state.currentBookId = null;
      showView('shelf');
      await loadBooks();
    } catch (e) {
      toast(e.message, 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = '删除';
    }
  });
}

// ================= 工作台（入口，完整渲染见后续子步骤） =================

async function openWorkspace(bookId) {
  state.currentBookId = bookId;
  showView('workspace');
  const meta = state.books.find((b) => b.id === bookId);
  $('#ws-title').textContent = meta ? meta.title : '…';
  state.events = [];
  state.streamRounds = [];
  state.streamBuf = '';
  $('#events').innerHTML = '';
  $('#stream').innerHTML = '';
  await refreshSnapshot();
  connectStream();
  startSnapshotPolling();
}

// refreshSnapshot 拉取当前书快照并刷新界面（子步骤 15 完善渲染）。
async function refreshSnapshot() {
  if (!state.currentBookId) return;
  try {
    state.snapshot = await api('/api/books/' + state.currentBookId);
    // 引擎离开 idle（running/paused/completed）即启动完成，清除启动中提示。
    if (state.pendingStart && (state.snapshot.IsRunning || state.snapshot.RuntimeState !== 'idle')) {
      state.pendingStart = false;
    }
    renderWorkspace();
  } catch (e) {
    toast('快照刷新失败：' + e.message, 'error');
  }
}

// ================= 工作台四区渲染 =================

function renderWorkspace() {
  const s = state.snapshot;
  if (!s) return;
  renderStatusPill(s);
  renderStatePanel(s);
  renderDetailPanel(s);
  renderEvents();
  renderStreamLive();
}

// ---- 顶栏状态 ----
function renderStatusPill(s) {
  const pill = $('#ws-status');
  let cls = '';
  let label = s.StatusLabel || s.RuntimeState || '';
  if (s.IsRunning) cls = 'running';
  else if (s.RuntimeState === 'paused' || s.RuntimeState === 'pausing') cls = 'paused';
  else if (s.RuntimeState === 'completed') { cls = 'ok'; label = label || '已完结'; }
  else if (s.RuntimeState === 'idle') cls = '';
  pill.className = 'status-pill ' + cls;
  pill.textContent = label;
}

// ---- 左栏：状态 ----
function renderStatePanel(s) {
  const root = $('#state-content');
  root.innerHTML = '';
  const startBanner = state.pendingStart
    ? el('div', { class: 'start-banner', text: '⚙ 正在执行启动裁定（通常需 10~60 秒），进度见事件流…' })
    : null;
  // 原生 append 会把 null 渲染成 "null" 文本：banner 单独条件追加。
  if (startBanner) root.append(startBanner);
  root.append(
    statSection('概览', [
      statRow('运行态', s.StatusLabel || s.RuntimeState || '—'),
      statRow('阶段', s.Phase || '—'),
      statRow('流程', s.Flow || '—'),
      statRow('当前章节', s.CurrentChapter ? String(s.CurrentChapter) : '—'),
      statRow('已完成', s.CompletedCount ? String(s.CompletedCount) : '0'),
      statRow('总字数', s.TotalWordCount ? String(s.TotalWordCount) : '0'),
    ]),
    statSection('运行角色', agentRows(s.Agents)),
    statSection('返工', s.PendingRewrites && s.PendingRewrites.length
      ? [statRow('章节', s.PendingRewrites.join(', ')), statRow('原因', s.RewriteReason || '—')]
      : [statRow('无', '')]),
    statSection('干预', s.PendingSteer ? [statRow('待处理', s.PendingSteer)] : [statRow('无', '')]),
    statSection('验收', s.HasAdvanceHold
      ? [statRow('放行章', String(s.AdvancePermitChapter || '')), statRow('原因', s.AdvanceHoldReason || '—')]
      : [statRow('模式', s.AdvanceMode || 'auto')]),
    statSection('用量', [
      statRow('输入 tokens', fmtTokens(s.TotalInputTokens)),
      statRow('输出 tokens', fmtTokens(s.TotalOutputTokens)),
      statRow('花费', fmtCost(s.TotalCostUSD)),
      statRow('缓存节省', fmtCost(s.TotalSavedUSD)),
      ...(s.BudgetLimitUSD ? [statRow('预算上限', '$' + s.BudgetLimitUSD)] : []),
    ]),
    statSection('缓存诊断', [
      statRow('可用', s.OverallCacheCapable ? '是' : '否'),
      statRow('近期命中', s.OverallRecentSamples ? Math.round(100 * s.OverallRecentCacheRead / (s.OverallRecentInput || 1)) + '%' : '—'),
      statRow('缓存断裂', String(s.TotalCacheBreaks || 0)),
    ]),
    statSection('上下文', [
      statRow('占用', fmtTokens(s.ContextTokens) + ' / ' + fmtTokens(s.ContextWindow)),
      statRow('比例', s.ContextPercent ? Math.round(s.ContextPercent * 100) + '%' : '—'),
      statRow('策略', s.ContextStrategy || '—'),
      statRow('消息', String(s.ContextActiveMessages || 0)),
    ])
  );
}

function statSection(head, rows) {
  return el('div', { class: 'stat-section' },
    el('div', { class: 'head', text: head }),
    ...rows
  );
}

function statRow(k, v) {
  return el('div', { class: 'stat-row' },
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v == null ? '—' : String(v) })
  );
}

function agentRows(agents) {
  if (!agents || !agents.length) return [statRow('无', '')];
  return agents.map((a) => statRow(
    (a.Name || '?') + ' · ' + (a.State || ''),
    (a.Tool || a.Summary || a.TaskKind || '') 
  ));
}

// ---- 右栏：详情 ----
function renderDetailPanel(s) {
  const root = $('#detail-content');
  root.innerHTML = '';
  const parts = [];

  if (s.NovelName) parts.push(detailSection('书名', s.NovelName));
  if (s.Premise) parts.push(detailSection('前提', s.Premise));

  if (s.Outline && s.Outline.length) {
    const outlineText = s.Outline.map((o) => `第${o.Chapter}章 ${o.Title || ''}${o.CoreEvent ? ' — ' + o.CoreEvent : ''}`).join('\n');
    parts.push(detailSection('大纲', outlineText));
  } else if (s.CurrentVolumeArc || s.NextVolumeTitle) {
    parts.push(detailSection('卷弧', [
      s.CurrentVolumeArc ? '当前卷：' + s.CurrentVolumeArc : '',
      s.NextVolumeTitle ? '下一卷：' + s.NextVolumeTitle : '',
    ].filter(Boolean).join('\n')));
  }

  if (s.Characters && s.Characters.length) {
    parts.push(detailSection('角色', s.Characters.join('\n')));
  }
  if (s.SupportingCount) {
    parts.push(detailSection('配角', (s.RecentSupporting || []).join('、') || '共 ' + s.SupportingCount + ' 名'));
  }
  if (s.LastCommitSummary) parts.push(detailSection('最近提交', s.LastCommitSummary));
  if (s.LastReviewSummary) parts.push(detailSection('最近审阅', s.LastReviewSummary));
  if (s.LastCheckpointName) parts.push(detailSection('最近检查点', s.LastCheckpointName));
  if (s.RecentSummaries && s.RecentSummaries.length) {
    parts.push(detailSection('摘要', s.RecentSummaries.map((x, i) => '· ' + x).join('\n')));
  }
  if (!parts.length) parts.push(detailSection('暂无', '书尚未开始创作。'));

  root.append(...parts);
}

function detailSection(head, text) {
  const div = el('div', { class: 'detail-section' },
    el('div', { class: 'head', text: head }),
    el('div', { class: 'body' })
  );
  div.querySelector('.body').innerHTML = md(text == null ? '' : String(text));
  return div;
}

// ---- 中栏：事件流 ----
function renderEvents() {
  const root = $('#events');
  const nearBottom = isNearBottom(root);
  root.innerHTML = '';
  for (const ev of state.events) {
    const running = ev.ID && !ev.FinishedAt;
    const cat = ev.Category || '';
    const line = el('div', { class: 'ev cat-' + cat + (running ? ' running' : '') },
      el('span', { class: 'time', text: fmtTime(ev.Time) }),
      el('span', { class: 'cat', text: cat || 'EVENT' }),
      ev.Agent ? el('span', { class: 'agent muted', text: '[' + ev.Agent + '] ' }) : null,
      el('span', { class: 'summary', text: ev.Summary || '' })
    );
    root.append(line);
  }
  if (nearBottom || state.events.length < 200) root.scrollTop = root.scrollHeight;
}

// ---- 中栏：输出 ----
// 流式文本按 ThinkingSep（\x02）分段：奇数段为思考内容（纯文本），偶数段为正文（markdown 渲染）。
function renderStreamRound(round) {
  const text = String((round && round.text) || '');
  const parts = text.split('\x02');
  const nodes = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (i > 0 && i % 2 !== 0) {
      nodes.push(el('div', { class: 'stream-thinking', text: part }));
    } else {
      const div = el('div', { class: 'stream-round' });
      div.innerHTML = md(part);
      nodes.push(div);
    }
  });
  return nodes;
}

function renderStreamLive() {
  const root = $('#stream');
  const nearBottom = isNearBottom(root);
  root.innerHTML = '';
  const all = state.streamRounds.concat([{ text: state.streamBuf }]);
  for (const round of all) {
    root.append(...renderStreamRound(round));
  }
  if (nearBottom) root.scrollTop = root.scrollHeight;
}

// ---- 输入栏 ----
function bindInput() {
  const ta = $('#input');
  $('#btn-send').addEventListener('click', () => sendInput());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  });
}

function bindTabs() {
  // 事件流/输出同屏：事件流顶部标题点击折叠/展开。
  const events = $('#center-events');
  const icon = $('#events-fold-icon');
  $('#btn-toggle-events').addEventListener('click', () => {
    const collapsed = events.classList.toggle('collapsed');
    icon.textContent = collapsed ? '▸' : '▾';
  });
}

async function sendInput() {
  const ta = $('#input');
  const text = ta.value.trim();
  if (!text) return;
  if (text.startsWith('/')) {
    runCommand(text);
    return;
  }
  ta.value = '';
  const id = state.currentBookId;
  try {
    if (state.snapshot && state.snapshot.IsRunning) {
      await postJSON(`/api/books/${id}/steer`, { text });
    } else {
      await postJSON(`/api/books/${id}/continue`, { text });
    }
    await refreshSnapshot();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ================= 斜杠命令与命令面板 =================

const COMMANDS = {
  help:      { usage: '/help',                     desc: '查看命令列表',            run: () => openHelpModal() },
  model:     { usage: '/model [role]',             desc: '切换角色模型与推理强度',  run: () => openModelsModal() },
  config:    { usage: '/config',                   desc: '新增或编辑 Provider 与模型', run: () => openConfigModal() },
  diag:      { usage: '/diag',                     desc: '诊断小说创作健康度',      run: () => openDiagModal() },
  review:    { usage: '/review on|off',            desc: '切换逐章验收模式',        run: (a) => setAdvanceMode(a[0]) },
  next:      { usage: '/next',                     desc: '验收后放行新章节',        run: () => postControl('advance') },
  reopen:    { usage: '/reopen [续写方向]',         desc: '重开已完结的书继续创作',  run: (a) => postControl('reopen', { text: (a || []).join(' ') }) },
  import:    { usage: '/import',                   desc: '语义导入外部小说',        run: () => openImportModal() },
  simulate:  { usage: '/simulate',                 desc: '生成或更新仿写画像',      run: () => startSimulate() },
  importsim: { usage: '/importsim <profile.json>', desc: '导入已有仿写画像',        run: () => openImportSimModal() },
  export:    { usage: '/export',                   desc: '导出已完成章节为 TXT/EPUB', run: () => openExportModal() },
  cocreate:  { usage: '/cocreate',                 desc: '暂停创作，共创规划后续走向', run: () => openCoCreateModal(false) },
};

function runCommand(text) {
  hidePalette();
  // 命令执行后从输入框消失（不再可编辑）。
  $('#input').value = '';
  const m = text.slice(1).trim().match(/^([^\s]+)\s*(.*)$/);
  if (!m) return;
  const name = m[1].toLowerCase();
  const args = m[2] ? m[2].split(/\s+/) : [];
  const cmd = COMMANDS[name];
  if (!cmd) { toast('未知命令：/' + name, 'error'); return; }
  cmd.run(args);
}

// 统一运行控制类请求
async function postControl(action, body) {
  const id = state.currentBookId;
  try {
    await postJSON(`/api/books/${id}/${action}`, body || {});
    await refreshSnapshot();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function setAdvanceMode(v) {
  if (v !== 'on' && v !== 'off') { toast('用法：/review on|off', 'error'); return; }
  await postControl('advance-mode', { mode: v === 'on' ? 'review' : 'auto' });
}

// ---- 命令面板浮层 ----
let paletteEl = null;

function buildPalette() {
  if (paletteEl) return paletteEl;
  paletteEl = el('div', { class: 'palette hidden', id: 'palette' });
  const bar = $('.input-bar');
  // 作为 input-bar 的第一个子元素：palette 的 absolute 定位以 .input-bar（relative）为上下文。
  if (bar) bar.prepend(paletteEl);
  return paletteEl;
}

function showPalette(query) {
  const q = query.slice(1).trim().toLowerCase();
  const items = Object.entries(COMMANDS).filter(([name, cmd]) =>
    !q || name.includes(q) || (cmd.usage || '').includes(q)
  );
  const box = buildPalette();
  box.innerHTML = '';
  box.classList.remove('hidden');
  const run = (name) => { $('#input').value = '/' + name; runCommand('/' + name); };
  for (const [name, cmd] of items.slice(0, 8)) {
    box.append(el('div', { class: 'palette-item', onclick: () => run(name) },
      el('span', { class: 'palette-name', text: '/' + name }),
      el('span', { class: 'palette-desc muted', text: cmd.desc })
    ));
  }
  if (!items.length) box.append(el('div', { class: 'palette-item muted', text: '无匹配命令' }));
}

function hidePalette() {
  if (paletteEl) paletteEl.classList.add('hidden');
}

function bindPalette() {
  const ta = $('#input');
  ta.addEventListener('input', () => {
    const v = ta.value;
    if (v.startsWith('/') && !v.includes('\n')) showPalette(v);
    else hidePalette();
  });
  ta.addEventListener('blur', () => setTimeout(hidePalette, 150));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && paletteEl && !paletteEl.classList.contains('hidden')) {
      e.preventDefault();
      const first = paletteEl.querySelector('.palette-name');
      if (first) { ta.value = first.textContent; showPalette(ta.value); }
    }
  });
}

// ---- 帮助 ----
function openHelpModal() {
  const rows = Object.values(COMMANDS).map((c) =>
    el('div', { class: 'stat-row' },
      el('span', { class: 'k', text: c.usage }),
      el('span', { class: 'v muted', text: c.desc })
    )
  );
  openModal({ title: '命令帮助', body: rows });
}

// ================= 模态框：模型切换 / 配置 / 诊断 =================

async function openModelsModal() {
  const id = state.currentBookId;
  let data;
  try {
    data = await api(`/api/books/${id}/models`);
  } catch (e) { toast(e.message, 'error'); return; }

  const roleSel = el('select', {},
    ...Object.keys(data.current || {}).map((role) => el('option', { value: role, text: role || 'default' }))
  );
  const providerSel = el('select', {});
  const modelSel = el('select', {});
  const thinkingSel = el('select', {});

  const fillModels = () => {
    modelSel.innerHTML = '';
    for (const m of (data.models[providerSel.value] || [])) {
      modelSel.append(el('option', { value: m, text: m }));
    }
  };
  const selectCurrent = () => {
    const cur = (data.current[roleSel.value] || {});
    providerSel.innerHTML = '';
    for (const p of data.providers) providerSel.append(el('option', { value: p, text: p }));
    if (cur.provider) providerSel.value = cur.provider;
    fillModels();
    if (cur.model) modelSel.value = cur.model;
    thinkingSel.innerHTML = '';
    for (const lv of (data.thinking_levels[roleSel.value] || [])) {
      thinkingSel.append(el('option', { value: lv, text: lv || '默认' }));
    }
  };
  roleSel.addEventListener('change', selectCurrent);
  providerSel.addEventListener('change', fillModels);

  const saveBtn = el('button', { class: 'btn primary', type: 'button', text: '应用' });
  const modal = openModal({
    title: '模型切换',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      el('label', { text: '角色' }, roleSel),
      el('label', { text: 'Provider' }, providerSel),
      el('label', { text: '模型' }, modelSel),
      el('label', { text: '推理强度' }, thinkingSel)
    ),
    footer: [saveBtn],
    onMount: selectCurrent,
  });

  saveBtn.addEventListener('click', async () => {
    const role = roleSel.value;
    try {
      await postJSON(`/api/books/${id}/switch-model`, { role, provider: providerSel.value, model: modelSel.value });
      const lv = thinkingSel.value;
      if (lv) await postJSON(`/api/books/${id}/set-thinking`, { role, level: lv });
      toast('模型已切换', 'ok');
      modal.close();
      await refreshSnapshot();
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function openConfigModal() {
  const id = state.currentBookId;
  let snap;
  try {
    snap = await api(`/api/books/${id}/config`);
  } catch (e) { toast(e.message, 'error'); return; }

  const providers = snap.Providers || [];
  const nameSel = el('select', {},
    ...providers.map((p) => el('option', { value: p.Name, text: p.Name })),
    el('option', { value: '__new__', text: '＋ 新增 Provider' })
  );
  const nameInput = el('input', { type: 'text', placeholder: 'Provider 名称（新增时填写）', class: 'hidden' });
  const typeSel = el('select', {},
    el('option', { value: 'openai', text: 'OpenAI 兼容' }),
    el('option', { value: 'anthropic', text: 'Anthropic 兼容' }),
    el('option', { value: 'gemini', text: 'Gemini 兼容' })
  );
  const apiSel = el('select', {},
    el('option', { value: 'chat', text: 'chat' }),
    el('option', { value: 'responses', text: 'responses' })
  );
  const baseInput = el('input', { type: 'text', placeholder: 'Base URL（留空使用默认）' });
  const keyHint = el('p', { class: 'muted', text: '' });
  const keyInput = el('input', { type: 'password', placeholder: '新 API Key（留空保持原样）', autocomplete: 'off' });
  const clearKey = el('label', { style: 'flex-direction:row;gap:6px' },
    el('input', { type: 'checkbox' }), ' 清除已存 API Key');
  const modelsInput = el('textarea', { rows: 5, placeholder: '模型列表，每行一个：\nmodel-name\nmodel-name=128000（可指定上下文窗口）' });

  const fillProvider = () => {
    const name = nameSel.value;
    const isNew = name === '__new__';
    nameInput.classList.toggle('hidden', !isNew);
    if (isNew) return;
    const p = providers.find((x) => x.Name === name);
    if (!p) return;
    typeSel.value = p.Type || 'openai';
    apiSel.value = p.API || 'chat';
    baseInput.value = p.BaseURL || '';
    keyHint.textContent = p.HasAPIKey ? ('已保存密钥：' + (p.APIKeyHint || '****')) : (p.RequiresAPIKey ? '未设置 API Key' : '该 Provider 无需 API Key');
    modelsInput.value = (p.Models || []).map((m) =>
      m.context_window ? `${m.name}=${m.context_window}` : m.name
    ).join('\n');
  };
  nameSel.addEventListener('change', fillProvider);

  const testBtn = el('button', { class: 'btn', type: 'button', text: '测试连接' });
  const saveBtn = el('button', { class: 'btn primary', type: 'button', text: '保存' });
  const modal = openModal({
    title: 'Provider / 模型配置',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      el('label', { text: 'Provider' }, nameSel),
      el('label', { text: 'Provider 名称（新增）' }, nameInput),
      el('label', { text: 'API 协议类型' }, typeSel),
      el('label', { text: 'API 模式' }, apiSel),
      el('label', { text: 'Base URL' }, baseInput),
      keyHint,
      el('label', { text: 'API Key' }, keyInput),
      clearKey,
      el('label', { text: '模型列表' }, modelsInput)
    ),
    footer: [testBtn, saveBtn],
    onMount: fillProvider,
  });

  const buildDraft = () => {
    const isNew = nameSel.value === '__new__';
    const provider = isNew ? nameInput.value.trim() : nameSel.value;
    if (!provider) throw new Error('Provider 名称不能为空');
    const models = [];
    for (const line of modelsInput.value.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq > 0) models.push({ name: s.slice(0, eq).trim(), context_window: parseInt(s.slice(eq + 1), 10) || 0 });
      else models.push({ name: s });
    }
    if (!models.length) throw new Error('至少需要一个模型');
    return {
      provider,
      type: typeSel.value,
      api: apiSel.value,
      base_url: baseInput.value.trim(),
      models,
      renames: [],
      api_key_action: clearKey.querySelector('input').checked ? 'clear' : (keyInput.value ? 'replace' : 'keep'),
      api_key: keyInput.value,
    };
  };

  testBtn.addEventListener('click', async () => {
    let draft;
    try { draft = buildDraft(); } catch (e) { toast(e.message, 'error'); return; }
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    try {
      await postJSON(`/api/books/${id}/config/test`, { draft, model: draft.models[0].name });
      toast('连接成功', 'ok');
    } catch (e) {
      toast('连接失败：' + e.message, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '测试连接';
    }
  });

  saveBtn.addEventListener('click', async () => {
    let draft;
    try { draft = buildDraft(); } catch (e) { toast(e.message, 'error'); return; }
    saveBtn.disabled = true;
    try {
      await postJSON(`/api/books/${id}/config`, { draft });
      toast('配置已保存', 'ok');
      modal.close();
    } catch (e) {
      toast(e.message, 'error');
      saveBtn.disabled = false;
    }
  });
}

async function openDiagModal() {
  const id = state.currentBookId;
  const body = el('div', { class: 'muted', text: '诊断生成中…' });
  const modal = openModal({ title: '诊断报告', body, wide: true });
  let rep;
  try {
    const res = await postJSON(`/api/books/${id}/diag`, {});
    rep = res.report || {};
  } catch (e) {
    body.textContent = '诊断失败：' + e.message;
    return;
  }
  body.innerHTML = '';
  const st = rep.Stats || {};
  body.append(
    el('div', { class: 'stat-section' },
      el('div', { class: 'head', text: '概览' }),
      statRow('进度', `${st.CompletedChapters || 0}/${st.TotalChapters || 0} 章`),
      statRow('字数', fmtTokens(st.TotalWords || 0)),
      statRow('平均每章', fmtTokens(st.AvgWordsPerCh || 0)),
      statRow('阶段', st.Phase || '—'),
      statRow('审阅次数', String(st.ReviewCount || 0)),
      statRow('返工次数', String(st.RewriteCount || 0)),
      statRow('平均评分', st.AvgReviewScore ? st.AvgReviewScore.toFixed(1) : '—'),
      statRow('未收束伏笔', String(st.ForeshadowOpen || 0) + '（滞留 ' + (st.ForeshadowStale || 0) + '）')
    )
  );
  const findings = rep.Findings || [];
  if (findings.length) {
    body.append(el('div', { class: 'stat-section' },
      el('div', { class: 'head', text: '发现 (' + findings.length + ')' }),
      ...findings.map((f) => el('div', { class: 'detail-section' },
        el('div', { class: 'head', text: `[${f.Severity || 'info'}] ${f.Title || f.Rule || ''}` }),
        f.Evidence ? el('div', { class: 'body', text: '证据：' + f.Evidence }) : null,
        f.Suggestion ? el('div', { class: 'body warn', text: '建议：' + f.Suggestion }) : null
      ))
    ));
  } else {
    body.append(el('p', { class: 'ok', text: '未发现明显问题。' }));
  }
  const actions = rep.Actions || [];
  if (actions.length) {
    body.append(el('div', { class: 'stat-section' },
      el('div', { class: 'head', text: '建议动作' }),
      ...actions.map((a) => el('div', { class: 'detail-section' },
        el('div', { class: 'body', text: a.Summary || a.Message || '' })
      ))
    ));
  }
}

// ================= 模态框：全局配置（profile） =================

async function openProfileModal() {
  let prof;
  try {
    prof = await api('/api/profile');
  } catch (e) { toast(e.message, 'error'); return; }
  let snap;
  try {
    snap = await api('/api/profile/config');
  } catch (e) {
    if (prof.setup_needed) {
      openModal({ title: '配置', body: el('p', { class: 'muted', text: '尚未配置 Provider 与模型，请先完成首次引导（/setup）。' }) });
      return;
    }
    toast(e.message, 'error');
    return;
  }

  const providers = snap.providers || [];
  const nameSel = el('select', {},
    ...providers.map((p) => el('option', { value: p.name, text: p.name })),
    el('option', { value: '__new__', text: '＋ 新增 Provider' })
  );
  const nameInput = el('input', { type: 'text', placeholder: 'Provider 名称（新增时填写）', class: 'hidden' });
  const typeSel = el('select', {},
    el('option', { value: 'openai', text: 'OpenAI 兼容' }),
    el('option', { value: 'anthropic', text: 'Anthropic 兼容' }),
    el('option', { value: 'gemini', text: 'Gemini 兼容' })
  );
  const apiSel = el('select', {},
    el('option', { value: 'chat', text: 'chat' }),
    el('option', { value: 'responses', text: 'responses' })
  );
  const baseInput = el('input', { type: 'text', placeholder: 'Base URL（留空使用默认）' });
  const keyHint = el('p', { class: 'muted', text: '' });
  const keyInput = el('input', { type: 'password', placeholder: '新 API Key（留空保持原样）', autocomplete: 'off' });
  const clearKey = el('label', { style: 'flex-direction:row;gap:6px' },
    el('input', { type: 'checkbox' }), ' 清除已存 API Key');
  const modelsInput = el('textarea', { rows: 5, placeholder: '模型列表，每行一个：\nmodel-name\nmodel-name=128000（可指定上下文窗口）' });

  const fillProvider = () => {
    const name = nameSel.value;
    const isNew = name === '__new__';
    nameInput.classList.toggle('hidden', !isNew);
    if (isNew) return;
    const p = providers.find((x) => x.name === name);
    if (!p) return;
    typeSel.value = p.type || 'openai';
    apiSel.value = p.api || 'chat';
    baseInput.value = p.base_url || '';
    keyHint.textContent = p.has_api_key ? '已保存 API Key（可替换或清除）' : '未设置 API Key';
    modelsInput.value = (p.models || []).map((m) =>
      m.context_window ? `${m.name}=${m.context_window}` : m.name
    ).join('\n');
  };
  nameSel.addEventListener('change', fillProvider);

  const userLine = el('div', { class: 'stat-row' },
    el('span', { class: 'k', text: '当前用户' }),
    el('span', { class: 'v', text: authInfo.display_name || '用户' })
  );

  const saveBtn = el('button', { class: 'btn primary', type: 'button', text: '保存' });
  const modal = openModal({
    title: '全局配置',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      userLine,
      el('label', { text: 'Provider' }, nameSel),
      el('label', { text: 'Provider 名称（新增）' }, nameInput),
      el('label', { text: 'API 协议类型' }, typeSel),
      el('label', { text: 'API 模式' }, apiSel),
      el('label', { text: 'Base URL' }, baseInput),
      keyHint,
      el('label', { text: 'API Key' }, keyInput),
      clearKey,
      el('label', { text: '模型列表' }, modelsInput)
    ),
    footer: [saveBtn],
    onMount: fillProvider,
  });

  const buildDraft = () => {
    const isNew = nameSel.value === '__new__';
    const provider = isNew ? nameInput.value.trim() : nameSel.value;
    if (!provider) throw new Error('Provider 名称不能为空');
    const models = [];
    for (const line of modelsInput.value.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq > 0) models.push({ name: s.slice(0, eq).trim(), context_window: parseInt(s.slice(eq + 1), 10) || 0 });
      else models.push({ name: s });
    }
    if (!models.length) throw new Error('至少需要一个模型');
    return {
      provider,
      type: typeSel.value,
      api: apiSel.value,
      base_url: baseInput.value.trim(),
      models,
      renames: [],
      api_key_action: clearKey.querySelector('input').checked ? 'clear' : (keyInput.value ? 'replace' : 'keep'),
      api_key: keyInput.value,
    };
  };

  saveBtn.addEventListener('click', async () => {
    let draft;
    try { draft = buildDraft(); } catch (e) { toast(e.message, 'error'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await postJSON('/api/profile/config', { draft });
      toast('配置已保存（全局生效）', 'ok');
      modal.close();
    } catch (e) {
      toast(e.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });
}

// ================= 附加流事件（import/sim/cocreate）分发 =================

// state.auxHandlers 由模态框注册；SSE 收到附加流事件时调用。
state.auxHandlers = [];

function onAux(kind, payload) {
  for (const h of state.auxHandlers) {
    if (h.kind === kind) { try { h.fn(payload); } catch (e) { console.error('aux handler', e); } }
  }
}

// ================= 模态框：导入 / 仿写 / 导出 / 共创 =================

function openImportModal() {
  const id = state.currentBookId;
  // 文件上传区（点击选择 / 拖拽）。
  const fileInput = el('input', { type: 'file', class: 'hidden' });
  let pickedFile = null;
  const dropZone = el('div', { class: 'drop-zone', text: '＋ 点击选择文件，或将小说文件拖拽到此处' });
  const setFile = (f) => {
    pickedFile = f;
    dropZone.textContent = f ? '📄 ' + f.name + '（点击可重新选择）' : '＋ 点击选择文件，或将小说文件拖拽到此处';
    dropZone.classList.toggle('has-file', !!f);
  };
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => setFile(fileInput.files[0] || null));
  ['dragover', 'dragenter'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
  }));
  dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  const sourceInput = el('input', { type: 'text', placeholder: '或直接输入服务器上的文件路径（留空恢复未完成导入）' });
  const yesBox = el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
    el('input', { type: 'checkbox' }), ' 自动接受切分（--yes）');
  const storySel = el('select', {},
    el('option', { value: '', text: '结局自动判定' }),
    el('option', { value: 'open', text: '开放结局（--story=open）' }),
    el('option', { value: 'closed', text: '闭环结局（--story=closed）' })
  );
  const contBox = el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
    el('input', { type: 'checkbox' }), ' 导入后直接续写（--continue）');
  const guideInput = el('input', { type: 'text', placeholder: '切分指导（--guide，可空）' });
  const logBox = el('div', { class: 'scroll-area', style: 'height:220px;border:1px solid var(--border);border-radius:8px;background:var(--bg-3);font-size:12.5px' });

  const startBtn = el('button', { class: 'btn primary', type: 'button', text: '开始导入' });
  const confirmBtn = el('button', { class: 'btn primary hidden', type: 'button', text: '确认切分并继续' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
  const modal = openModal({
    title: '外部小说导入',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      fileInput,
      dropZone,
      el('label', { text: '服务器文件路径（与上传二选一）' }, sourceInput),
      yesBox, storySel, contBox,
      el('label', { text: '切分指导' }, guideInput),
      logBox
    ),
    footer: [cancelBtn, confirmBtn, startBtn],
    wide: true,
  });

  const log = (msg, cls) => {
    logBox.append(el('div', { class: cls || '', text: msg }));
    logBox.scrollTop = logBox.scrollHeight;
  };
  const handler = { kind: 'import', fn: (ev) => {
    if (ev.error) { log('✗ ' + ev.error, 'error'); startBtn.disabled = false; return; }
    log(`[${ev.stage || '—'}] ${ev.message || ''}${ev.current ? '（' + ev.current + '/' + ev.total + '）' : ''}`, ev.level === 'warn' ? 'warn' : '');
    if (ev.stage === 'awaiting_confirmation') confirmBtn.classList.remove('hidden');
    if (ev.stage === 'done') log('✓ 导入完成' + (ev.continued ? '（已接力续写）' : ''), 'ok');
    if (ev.retry_at) log('⏳ 重试中…', 'warn');
  }};
  state.auxHandlers.push(handler);
  const origClose = modal.close;
  modal.close = () => {
    state.auxHandlers = state.auxHandlers.filter((h) => h !== handler);
    origClose();
  };

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      if (pickedFile) {
        const fd = new FormData();
        fd.append('file', pickedFile);
        fd.append('story', storySel.value);
        fd.append('guidance', guideInput.value.trim());
        fd.append('auto_confirm', yesBox.querySelector('input').checked ? '1' : '0');
        fd.append('continue', contBox.querySelector('input').checked ? '1' : '0');
        await api(`/api/books/${id}/import`, { method: 'POST', body: fd });
      } else {
        await postJSON(`/api/books/${id}/import`, {
          source_path: sourceInput.value.trim(),
          auto_confirm: yesBox.querySelector('input').checked,
          story: storySel.value,
          continue: contBox.querySelector('input').checked,
          guidance: guideInput.value.trim(),
        });
      }
      log('导入已启动…', 'muted');
    } catch (e) {
      toast(e.message, 'error');
      startBtn.disabled = false;
    }
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await postJSON(`/api/books/${id}/import/confirm`, {});
      log('已确认切分，继续…', 'muted');
    } catch (e) {
      toast(e.message, 'error');
      confirmBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', async () => {
    await postJSON(`/api/books/${id}/import/cancel`, {}).catch(() => {});
    modal.close();
  });
}

// 通用附加操作模态框（仿写画像等：日志区 + 事件流渲染）
function openAuxModal(title, kind, action, payload) {
  const id = state.currentBookId;
  const logBox = el('div', { class: 'scroll-area', style: 'height:260px;border:1px solid var(--border);border-radius:8px;background:var(--bg-3);font-size:12.5px' });
  const runBtn = el('button', { class: 'btn primary', type: 'button', text: '开始' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
  const modal = openModal({ title, body: logBox, footer: [cancelBtn, runBtn], wide: true });

  const log = (msg, cls) => {
    logBox.append(el('div', { class: cls || '', text: msg }));
    logBox.scrollTop = logBox.scrollHeight;
  };
  const handler = { kind, fn: (ev) => {
    if (ev.error) { log('✗ ' + ev.error, 'error'); runBtn.disabled = false; return; }
    log(`[${ev.stage || '—'}] ${ev.message || ''}${ev.current ? '（' + ev.current + '/' + ev.total + '）' : ''}`);
    if (ev.stage === 'done') log('✓ 完成', 'ok');
  }};
  state.auxHandlers.push(handler);
  const origClose = modal.close;
  modal.close = () => {
    state.auxHandlers = state.auxHandlers.filter((h) => h !== handler);
    origClose();
  };

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = '运行中…';
    try {
      await postJSON(`/api/books/${id}/${action}`, payload || {});
      log('已启动…', 'muted');
    } catch (e) {
      toast(e.message, 'error');
      runBtn.disabled = false;
      runBtn.textContent = '开始';
    }
  });
  cancelBtn.addEventListener('click', async () => {
    await postJSON(`/api/books/${id}/import/cancel`, {}).catch(() => {});
    modal.close();
  });
}

function startSimulate() {
  openAuxModal('仿写画像', 'sim', 'simulate', {});
}

function openImportSimModal() {
  const id = state.currentBookId;
  const profileInput = el('input', { type: 'text', placeholder: 'profile.json 路径' });
  const startBtn = el('button', { class: 'btn primary', type: 'button', text: '导入' });
  const modal = openModal({
    title: '导入仿写画像',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      el('label', { text: '画像文件路径' }, profileInput)
    ),
    footer: [startBtn],
  });
  startBtn.addEventListener('click', async () => {
    const path = profileInput.value.trim();
    if (!path) { toast('请输入 profile.json 路径', 'error'); return; }
    modal.close();
    openAuxModal('导入仿写画像', 'sim', 'importsim', { profile_path: path });
  });
}

function openExportModal() {
  const id = state.currentBookId;
  const fmtSel = el('select', {},
    el('option', { value: 'txt', text: 'TXT' }),
    el('option', { value: 'epub', text: 'EPUB' })
  );
  const fromInput = el('input', { type: 'number', min: '0', placeholder: '起始章（可空）' });
  const toInput = el('input', { type: 'number', min: '0', placeholder: '结束章（可空）' });
  const overwriteBox = el('label', { style: 'flex-direction:row;align-items:center;gap:6px' },
    el('input', { type: 'checkbox' }), ' 覆盖已存在文件');
  const resultBox = el('div', { class: 'muted', style: 'min-height:30px' });
  const exportBtn = el('button', { class: 'btn primary', type: 'button', text: '导出' });
  const modal = openModal({
    title: '导出小说',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      el('label', { text: '格式' }, fmtSel),
      el('div', { style: 'display:flex;gap:10px' },
        el('label', { text: '起始章' }, fromInput),
        el('label', { text: '结束章' }, toInput)
      ),
      overwriteBox,
      resultBox
    ),
    footer: [exportBtn],
  });

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = '导出中…';
    try {
      const res = await postJSON(`/api/books/${id}/export`, {
        format: fmtSel.value,
        from: parseInt(fromInput.value, 10) || 0,
        to: parseInt(toInput.value, 10) || 0,
        overwrite: overwriteBox.querySelector('input').checked,
      });
      resultBox.innerHTML = '';
      resultBox.append(el('div', { class: 'ok', text: `✓ 已导出 ${res.chapters} 章 / ${fmtBytes(res.bytes)}` }));
      if (res.skipped && res.skipped.length) {
        resultBox.append(el('div', { class: 'warn', text: '跳过未完成章节：' + res.skipped.join(', ') }));
      }
      if (res.download) {
        resultBox.append(el('a', { href: res.download, class: 'btn', text: '下载文件',
          style: 'display:inline-block;margin-top:8px;text-decoration:none' }));
      }
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = '导出';
    }
  });
}

// 共创对话框（冷启动 = 新书共创；阶段 = 暂停创作规划后续走向）
function openCoCreateModal(coldStart) {
  const id = state.currentBookId;
  const messages = [];
  let currentReq = null;
  let latestDraft = '';

  const chatBox = el('div', { class: 'scroll-area', style: 'flex:1;min-height:0;border:1px solid var(--border);border-radius:8px;background:var(--bg-3);overflow-y:auto;font-size:13px' });
  const thinkingBox = el('div', { class: 'box-body', text: '（AI 思考中…）' });
  const draftBox = el('div', { class: 'box-body' });
  const input = el('textarea', { rows: 2, placeholder: '输入你的想法（Enter 发送，Shift+Enter 换行）…' });
  const sendBtn = el('button', { class: 'btn', type: 'button', text: '发送' });
  const applyBtn = el('button', { class: 'btn primary', type: 'button', text: coldStart ? '启动创作' : '应用指令并恢复' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '放弃' });

  const modal = openModal({
    title: coldStart ? '共创规划 · 新书' : '共创规划 · 阶段',
    body: el('div', { class: 'setup-wrap', style: 'margin:0;padding:0' },
      el('div', { class: 'cocreate-layout' },
        // 左：对话历史
        el('div', { class: 'cocreate-chat' }, chatBox),
        // 右：思考 + 创作指令草稿
        el('div', { class: 'cocreate-panel' },
          el('div', { class: 'box' },
            el('div', { class: 'box-title', text: 'AI 思考' }),
            thinkingBox
          ),
          el('div', { class: 'box' },
            el('div', { class: 'box-title', text: '创作指令草稿（Apply 后生效）' }),
            draftBox
          )
        )
      ),
      el('div', { style: 'display:flex;gap:8px;margin-top:10px' }, input, sendBtn)
    ),
    footer: [cancelBtn, applyBtn],
    wide: true,
    onMount: () => input.focus(),
  });

  const addChat = (node, cls) => {
    chatBox.append(el('div', { class: 'ev ' + (cls || ''), style: 'border:none' }, node));
    chatBox.scrollTop = chatBox.scrollHeight;
  };
  const renderDraft = () => {
    if (latestDraft) {
      draftBox.innerHTML = md(latestDraft);
    } else {
      draftBox.textContent = '（尚无创作指令，继续对话或等待 AI 给出）';
      draftBox.classList.add('muted');
    }
  };
  renderDraft();

  const handler = { kind: 'cocreate', fn: (p) => {
    if (!currentReq || p.req_id !== currentReq) return;
    if (p.kind === 'thinking') {
      thinkingBox.textContent = p.text;
    } else if (p.kind === 'reply') {
      // 回复预览同步进草稿区（模型边写边看）。
      draftBox.innerHTML = md(p.text || '');
      draftBox.classList.remove('muted');
    } else if (p.kind === 'done') {
      const reply = p.reply || {};
      thinkingBox.textContent = '';
      if (reply.Prompt) latestDraft = reply.Prompt;
      renderDraft();
      if (reply.Raw || reply.Message) messages.push({ role: 'assistant', content: reply.Raw || reply.Message });
      if (reply.Suggestions && reply.Suggestions.length) {
        const row = el('div', { class: 'suggest-row' });
        reply.Suggestions.forEach((sg) => {
          row.append(el('button', { class: 'suggest-btn', type: 'button', text: sg,
            onclick: () => { input.value = sg; input.focus(); } }));
        });
        addChat(el('div', {}, '建议：', row), 'muted');
      }
      addChat('—— AI 回复完成 ——', 'muted');
      currentReq = null;
      sendBtn.disabled = false;
    } else if (p.kind === 'error') {
      toast('共创失败：' + (p.error || ''), 'error');
      currentReq = null;
      sendBtn.disabled = false;
    }
  }};
  state.auxHandlers.push(handler);
  const origClose = modal.close;
  modal.close = () => {
    state.auxHandlers = state.auxHandlers.filter((h) => h !== handler);
    origClose();
  };

  async function send() {
    const text = input.value.trim();
    if (!text || currentReq) return;
    input.value = '';
    messages.push({ role: 'user', content: text });
    addChat('你：' + text);
    sendBtn.disabled = true;
    thinkingBox.textContent = '（AI 思考中…）';
    draftBox.textContent = '（等待回复…）';
    draftBox.classList.add('muted');
    try {
      const res = await postJSON(`/api/books/${id}/cocreate`, { messages, stage: !coldStart });
      currentReq = res.req_id;
    } catch (e) {
      toast(e.message, 'error');
      sendBtn.disabled = false;
    }
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  applyBtn.addEventListener('click', async () => {
    if (!latestDraft) { toast('AI 尚未给出可应用的创作指令', 'error'); return; }
    applyBtn.disabled = true;
    try {
      await postJSON(`/api/books/${id}/cocreate/apply`, { draft: latestDraft, stage: !coldStart });
      toast(coldStart ? '创作已启动' : '已恢复创作', 'ok');
      modal.close();
      state.pendingStart = coldStart;
      await refreshSnapshot();
    } catch (e) {
      toast(e.message, 'error');
      applyBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', async () => {
    if (!coldStart) await postJSON(`/api/books/${id}/cocreate/cancel`, {}).catch(() => {});
    modal.close();
  });
}

// ================= SSE 客户端与快照轮询 =================

let streamES = null;
let streamTimer = 0;
let snapshotTimer = 0;
let eventsRenderTimer = 0;

function connectStream() {
  disconnectStream();
  const id = state.currentBookId;
  if (!id) return;
  // 连接即服务端回放 ReplayQueue 历史（事件/流式），随后推送实时增量。
  streamES = new EventSource(`/api/books/${id}/stream`);
  streamES.addEventListener('event', (e) => {
    try {
      state.events.push(JSON.parse(e.data));
      scheduleEventsRender();
    } catch (_) { /* 忽略坏帧 */ }
  });
  streamES.addEventListener('delta', (e) => {
    try {
      state.streamBuf += JSON.parse(e.data);
      scheduleStreamRender();
    } catch (_) { /* 忽略坏帧 */ }
  });
  streamES.addEventListener('clear', () => {
    flushStreamRound();
    scheduleStreamRender();
  });
  streamES.addEventListener('done', () => {
    flushStreamRound();
    scheduleStreamRender();
    refreshSnapshot();
  });
  streamES.addEventListener('import', (e) => { try { onAux('import', JSON.parse(e.data)); } catch (_) {} });
  streamES.addEventListener('sim', (e) => { try { onAux('sim', JSON.parse(e.data)); } catch (_) {} });
  streamES.addEventListener('cocreate', (e) => { try { onAux('cocreate', JSON.parse(e.data)); } catch (_) {} });
  // EventSource 断线自动重连；重连后服务端再次回放历史补齐缺口。
  streamES.onerror = () => { /* 交给浏览器自动重连 */ };
}

function disconnectStream() {
  if (streamES) { streamES.close(); streamES = null; }
  if (streamTimer) { cancelAnimationFrame(streamTimer); streamTimer = 0; }
  if (eventsRenderTimer) { clearTimeout(eventsRenderTimer); eventsRenderTimer = 0; }
}

function startSnapshotPolling() {
  stopSnapshotPolling();
  snapshotTimer = setInterval(() => refreshSnapshot(), 3000);
}

function stopSnapshotPolling() {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = 0; }
}

// clear / done 时把当前流式轮次归档。
function flushStreamRound() {
  if (state.streamBuf) {
    state.streamRounds.push({ text: state.streamBuf });
    state.streamBuf = '';
  }
  if (state.streamRounds.length > 500) {
    state.streamRounds.splice(0, state.streamRounds.length - 500);
  }
}

function scheduleEventsRender() {
  if (eventsRenderTimer) return;
  eventsRenderTimer = setTimeout(() => {
    eventsRenderTimer = 0;
    renderEvents();
  }, 60);
}

function scheduleStreamRender() {
  if (streamTimer) return;
  streamTimer = requestAnimationFrame(() => {
    streamTimer = 0;
    renderStreamLive();
  });
}

// ================= 首次引导 =================

async function bindSetup() {
  let presets = [];
  try {
    const res = await api('/api/setup/presets');
    presets = res.presets || [];
  } catch (e) {
    $('#setup-error').textContent = '加载 Provider 列表失败：' + e.message;
    $('#setup-error').classList.remove('hidden');
    return;
  }
  const sel = $('#setup-provider');
  sel.innerHTML = '';
  for (const p of presets) sel.append(el('option', { value: p.name, text: p.label }));
  const applyPreset = () => {
    const p = presets.find((x) => x.name === sel.value);
    if (!p) return;
    $('#setup-provider-name').classList.toggle('hidden', !p.need_type);
    $('#setup-baseurl').placeholder = p.base_url || '留空使用官方地址';
    if (p.base_url) $('#setup-baseurl').value = p.base_url;
  };
  sel.addEventListener('change', applyPreset);
  applyPreset();

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#setup-error');
    errBox.classList.add('hidden');
    const model = $('#setup-model').value.trim();
    if (!model) {
      errBox.textContent = '模型名称必填';
      errBox.classList.remove('hidden');
      return;
    }
    const btn = $('#setup-form button[type=submit]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await postJSON('/api/setup', {
        provider: sel.value,
        provider_name: $('#setup-provider-name').value.trim(),
        api_key: $('#setup-apikey').value.trim(),
        base_url: $('#setup-baseurl').value.trim(),
        model,
      });
      toast('配置已保存', 'ok');
      showView('shelf');
      await loadBooks();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存配置';
    }
  });
}

// ================= 初始化 =================

function bindTopbar() {
  $('#btn-new-book').addEventListener('click', openNewBookModal);
  $('#btn-back').addEventListener('click', async () => {
    closeModal();
    disconnectStream();
    stopSnapshotPolling();
    state.currentBookId = null;
    showView('shelf');
    await loadBooks();
  });
  // 配置：全局 Provider/模型/API Key（登录后可用）。
  $('#btn-shelf-config').addEventListener('click', openProfileModal);
  $('#btn-ws-config').addEventListener('click', openProfileModal);
  $('#btn-models').addEventListener('click', () => {
    if (!state.currentBookId) { toast('请先打开一本书（书内 /model 按角色切换）', 'error'); return; }
    openModelsModal();
  });
  $('#btn-diag').addEventListener('click', () => {
    if (!state.currentBookId) { toast('请先打开一本书', 'error'); return; }
    openDiagModal();
  });
  $('#btn-help').addEventListener('click', openHelpModal);
  // 删除当前小说。
  $('#btn-delete-book').addEventListener('click', () => {
    if (!state.currentBookId) { toast('请先打开一本书', 'error'); return; }
    openDeleteBookModal();
  });
  // 暂停/继续（移动端无 Ctrl+C 快捷键，提供可见按钮）。
  $('#btn-pause').addEventListener('click', async () => {
    await postControl('abort');
  });
  $('#btn-resume').addEventListener('click', async () => {
    await postControl('resume');
  });
  // iOS 切后台/锁屏会挂起 EventSource：回到前台强制重连并刷新快照。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.currentBookId) {
      connectStream();
      refreshSnapshot();
    }
  });
}

async function init() {
  bindTopbar();
  bindInput();
  bindTabs();
  bindPalette();
  bindAuth();
  try {
    // 鉴权优先：未设置密码 → 设置页；未登录 → 登录页。
    const ok = await requireAuth();
    if (!ok) return;
    const health = await api('/api/health');
    if (health.setup) {
      showView('setup');
      await bindSetup();
      return;
    }
    showView('shelf');
    await loadBooks();
  } catch (e) {
    toast('无法连接后端：' + e.message, 'error');
    showView('shelf');
  }
}

init();
