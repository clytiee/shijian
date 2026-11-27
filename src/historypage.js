// historypage.js —— 历史记录页：列出全部记录（搜索 / 在页面中打开 / 复制 / 删除 / 清空）
const HISTORY_KEY = 'printHistory';
const HISTORY_MODE_KEY = 'historyRecordMode';
const HISTORY_MODE_DEFAULT = ['print'];

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const qEl = document.getElementById('q');
const modePrintEl = document.getElementById('mode-print');
const modeExtractEl = document.getElementById('mode-extract');
const clearAllBtn = document.getElementById('clear-all');
const toastEl = document.getElementById('toast');

let allRecords = [];
let toastTimer = null;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function load() {
  chrome.storage.local.get([HISTORY_KEY, HISTORY_MODE_KEY], (r) => {
    const list = Array.isArray(r && r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
    allRecords = list;
    const modes = Array.isArray(r && r[HISTORY_MODE_KEY]) ? r[HISTORY_MODE_KEY] : HISTORY_MODE_DEFAULT;
    if (modePrintEl) modePrintEl.checked = modes.indexOf('print') >= 0;
    if (modeExtractEl) modeExtractEl.checked = modes.indexOf('extract') >= 0;
    render();
  });
}

// 记录时机（打印/下载图片、提取）保存到 storage，content.js 每次写入前读它
function saveModes() {
  const modes = [];
  if (modePrintEl && modePrintEl.checked) modes.push('print');
  if (modeExtractEl && modeExtractEl.checked) modes.push('extract');
  chrome.storage.local.set({ [HISTORY_MODE_KEY]: modes }, () => {
    const err = chrome.runtime.lastError;
    if (err) { showToast('保存失败：' + err.message); return; }
    showToast(modes.length ? '记录时机已保存' : '两个时机都没勾：不再自动记录');
  });
}

if (modePrintEl) modePrintEl.addEventListener('change', saveModes);
if (modeExtractEl) modeExtractEl.addEventListener('change', saveModes);

function save(list, cb) {
  chrome.storage.local.set({ [HISTORY_KEY]: list }, () => {
    const err = chrome.runtime.lastError;
    if (err) { showToast('保存失败：' + err.message); return; }
    allRecords = list;
    render();
    if (cb) cb();
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function currentList() {
  const q = (qEl.value || '').trim().toLowerCase();
  if (!q) return allRecords.map((rec, i) => ({ rec, i }));
  return allRecords
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      const hay = [rec.title, rec.author, rec.text].join('\n').toLowerCase();
      return hay.includes(q);
    });
}

function render() {
  const items = currentList();
  countEl.textContent = allRecords.length ? `共 ${allRecords.length} 条，显示 ${items.length} 条` : '暂无记录';
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">${allRecords.length ? '没有匹配的记录' : '还没有历史记录：打印或下载图片时会自动记下一条'}</div>`;
    return;
  }
  listEl.innerHTML = items.map(({ rec, i }) => {
    const title = String(rec.title || '').trim() || '无标题';
    const author = String(rec.author || '').trim();
    const kind = rec.kind === 'download' ? '下载图片' : (rec.kind === 'print' ? '打印' : (rec.kind === 'extract' ? '提取' : ''));
    let host = '';
    try { host = rec.url ? new URL(rec.url).host : ''; } catch (e) { host = ''; }
    const preview = String(rec.summary || String(rec.text || '').replace(/\s+/g, ' ').slice(0, 120));
    const isLong = (typeof rec.len === 'number') ? rec.len > 120 : (String(rec.text || '').length > 120);
    return `<div class="item" data-index="${i}">
      <div class="top">
        <span class="title${rec.url ? ' has-url' : ''}" data-index="${i}"${rec.url ? ` title="在新标签页打开原网页：${esc(rec.url)}"` : ''}>${esc(title)}</span>
        ${author ? `<span class="author">${esc(author)}</span>` : ''}
        ${kind ? `<span class="tag">${esc(kind)}</span>` : ''}
        ${host ? `<span class="tag" title="${esc(rec.url)}">${esc(host)}</span>` : ''}
        <span class="time">${esc(fmtTime(rec.ts))}</span>
      </div>
      <div class="preview">${esc(preview)}${isLong ? '…' : ''}</div>
      <div class="ops">
        <button class="primary act-open" data-index="${i}" title="打开这条记录保存时所在的原网页，并把预览面板填好">重开预览</button>
        <button class="act-copy" data-index="${i}" title="复制标题、作者和正文全文">复制全文</button>
        <span class="spacer"></span>
        <button class="danger act-del" data-index="${i}">删除</button>
      </div>
    </div>`;
  }).join('');
}

function getRecord(i) {
  return allRecords[Number(i)];
}

listEl.addEventListener('click', (ev) => {
  // 点标题 = 在新标签页打开这条记录的原网页
  const titleEl = ev.target.closest('.title.has-url');
  if (titleEl) {
    const rec = getRecord(titleEl.dataset.index);
    if (rec && rec.url) chrome.tabs.create({ url: rec.url, active: true });
    return;
  }

  const btn = ev.target.closest('button');
  if (!btn) return;
  const i = Number(btn.dataset.index);

  if (btn.classList.contains('act-open')) {
    const rec = getRecord(i);
    if (!rec) return;
    chrome.runtime.sendMessage({ action: 'OPEN_HISTORY_IN_PAGE', record: rec }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.success) {
        // 原网页无法访问：让用户决定要不要换个网页开预览
        if (!window.confirm('原网页无法访问，是否改在其他标签页打开预览？')) return;
        chrome.runtime.sendMessage({ action: 'OPEN_HISTORY_ANYWAY', record: rec }, (r2) => {
          if (chrome.runtime.lastError || !r2 || !r2.success) {
            const why = r2 && r2.reason === 'no-tab' ? '没有可用的普通网页标签页' : '那个页面也注入不进去';
            showToast(`${why}，可用「复制全文」`);
            return;
          }
          showToast('已在其他标签页中打开预览');
        });
        return;
      }
      showToast(resp.url ? '已打开原网页并填好预览' : '已打开预览');
    });
    return;
  }

  if (btn.classList.contains('act-copy')) {
    const rec = getRecord(i);
    if (!rec) return;
    // 复制内容 = 标题 + 作者 + 正文全文
    const title = String(rec.title || '').trim();
    const author = String(rec.author || '').trim();
    const body = String(rec.text || '');
    const head = [title, author].filter(Boolean).join('　');
    const text = head ? `${head}\n\n${body}` : body;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('标题、作者、正文已复制'))
        .catch(() => showToast('复制失败'));
    } else {
      showToast('当前环境不支持剪贴板');
    }
    return;
  }

  if (btn.classList.contains('act-del')) {
    const next = allRecords.slice();
    next.splice(i, 1);
    save(next, () => showToast('已删除 1 条'));
  }
});

qEl.addEventListener('input', render);

clearAllBtn.addEventListener('click', () => {
  if (!allRecords.length) { showToast('暂无记录'); return; }
  if (!window.confirm(`确定清空全部 ${allRecords.length} 条历史记录？`)) return;
  save([], () => showToast('历史记录已清空'));
});

// 别的窗口改了历史（比如又打印了一次），这边实时刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[HISTORY_KEY] || changes[HISTORY_MODE_KEY])) load();
});

load();
