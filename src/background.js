// 点击插件图标时获取选中的文字并激活选择模式
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Background] 插件图标被点击');
  
  try {
    let selectedText = '';
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selection = window.getSelection();
          return selection ? selection.toString().trim() : '';
        }
      });
      selectedText = result[0]?.result || '';
      console.log('[Background] 获取到选中文字:', selectedText);
    } catch (e) {
      console.error('[Background] 获取选中文字失败:', e);
    }
    
    try {
      await chrome.tabs.sendMessage(tab.id, { 
        action: 'ACTIVATE_MODE',
        selectedText: selectedText 
      });
    } catch (err) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { 
            action: 'ACTIVATE_MODE',
            selectedText: selectedText 
          });
        } catch (e) {
          console.error('[Background] 激活失败:', e);
        }
      }, 100);
    }
  } catch (error) {
    console.error('[Background] 激活模式出错:', error);
  }
});

// 监听来自 content script 的截图请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Background] 收到消息:', request);

  // 记录最近一个普通网页标签页，供历史页「在网页中重开预览」用
  if (sender && sender.tab && sender.tab.id && sender.tab.url && !sender.tab.url.startsWith('chrome-extension://')) {
    rememberContentTab(sender.tab.id);
  }

  if (request.action === 'CAPTURE_PANEL') {
    console.log('[Background] 开始截图...');
    // 截图当前活动标签页的可见区域
    chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 })
      .then(dataUrl => {
        console.log('[Background] 截图成功，数据长度:', dataUrl.length);
        sendResponse({ success: true, dataUrl: dataUrl });
      })
      .catch(error => {
        console.error('[Background] 截图失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 保持消息通道开放，等待异步响应
  }

  // 历史页：告诉我「在网页中重开预览」该发到哪个标签页
  if (request.action === 'GET_LAST_CONTENT_TAB') {
    sendResponse({ success: !!lastContentTabId, tabId: lastContentTabId });
    return true;
  }

  // 历史页：把某条记录打开成预览面板（有原网页 URL 就把那个网页打开）
  // 原网页无法访问时不擅自换网页，只回 reason='load-failed'，由历史页问用户要不要换个网页开
  if (request.action === 'OPEN_HISTORY_IN_PAGE') {
    (async () => {
      const rec = request.record || {};
      const ok = await openRecordAnywhere(rec);
      sendResponse({ success: ok, url: rec.url || '', reason: ok ? '' : 'load-failed' });
    })();
    return true;
  }

  // 历史页：用户确认「在其他标签页打开预览」后走这里（用最近的普通网页）
  if (request.action === 'OPEN_HISTORY_ANYWAY') {
    (async () => {
      const rec = request.record || {};
      const tabId = await getContentTabId();
      if (!tabId) { sendResponse({ success: false, reason: 'no-tab' }); return; }
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      const ok = await sendHistoryRecord(tabId, rec);
      sendResponse({ success: ok, tabId, reason: ok ? '' : 'inject-failed' });
    })();
    return true;
  }

  if (request.action === 'OPEN_FONT_PAGE') {    // 由后台建标签页：网页里直接 window.open(chrome-extension://…) 会被 Chrome 拦成 ERR_BLOCKED_BY_CLIENT
    chrome.tabs.create({ url: chrome.runtime.getURL('fontpage.html') })
      .then((t) => sendResponse({ success: true, tabId: t && t.id }))
      .catch((e) => sendResponse({ success: false, error: e && e.message }));
    return true;
  }

  if (request.action === 'GET_LOCAL_FONTS') {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) {
          sendResponse({ success: false, fonts: [], error: 'no tab id' });
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            if (typeof window.queryLocalFonts !== 'function') {
              return { supported: false, fonts: [], error: 'unsupported' };
            }
            return window.queryLocalFonts().then(faces => {
              // 以 family 为准：同一家族的多字重只留一条
              const set = new Set();
              // 附带别名（fullName 等），供 content 搜索时一起匹配
              const aliases = {};
              (faces || []).forEach(f => {
                const name = f && (f.family || f.fullName);
                if (!name) return;
                const key = String(name).trim();
                set.add(key);
                const extra = (f.fullName && String(f.fullName).trim() !== key) ? String(f.fullName).trim() : '';
                if (extra) {
                  aliases[key] = aliases[key] || [];
                  if (!aliases[key].includes(extra)) aliases[key].push(extra);
                }
              });
              // 原始元数据（family / fullName / postscriptName / style），供“全部字体”页展示
              const meta = (faces || []).map(f => ({
                family: String(f.family || '').trim(),
                fullName: String(f.fullName || '').trim(),
                postscriptName: String(f.postscriptName || '').trim(),
                style: String(f.style || '').trim()
              })).filter(f => f.family || f.fullName);
              return { supported: true, fonts: Array.from(set).sort(), aliases, faces: meta, error: null };
            }).catch(err => ({
              supported: true,
              fonts: [],
              aliases: {},
              error: String((err && err.name) || err)
            }));
          }
        });
        const r = (results && results[0] && results[0].result) || {};
        sendResponse({ success: true, supported: r.supported !== false, fonts: r.fonts || [], aliases: r.aliases || {}, faces: r.faces || [], error: r.error });
      } catch (e) {
        sendResponse({ success: false, fonts: [], error: e.message });
      }
    })();
    return true;
  }
});

// ========== 右键菜单 ==========
// 「智能模式」开关 + 「历史记录」子菜单（点打印/下载图片时写入的最近记录）
const HISTORY_KEY = 'printHistory';
const HISTORY_MENU_MAX = 20;   // 菜单里最多列这么条（存储本身不设上限）

function getSync(key) {
  return new Promise((res) => chrome.storage.sync.get([key], (v) => res(v || {})));
}
function getLocal(key) {
  return new Promise((res) => chrome.storage.local.get([key], (v) => res(v || {})));
}

async function rebuildMenus() {
  // removeAll 的 Promise 版本偶尔早于内部清理完成，这里用回调确认顺序
  await new Promise((res) => {
    try { chrome.contextMenus.removeAll(() => res()); } catch (e) { res(); }
  });
  const sync = await getSync('smartMode');
  const smart = !!sync.smartMode;
  // create 都带上回调：并发/残留导致的 lastError 不留到控制台
  const create = (opt) => chrome.contextMenus.create(opt, () => { void chrome.runtime.lastError; });

  create({
    id: 'toggle-smart-mode',
    title: smart ? '✓ 智能模式（已开启）' : '智能模式（已关闭）',
    contexts: ['action']
  });

  const local = await getLocal(HISTORY_KEY);
  const list = Array.isArray(local[HISTORY_KEY]) ? local[HISTORY_KEY] : [];
  // 「历史记录」：打开独立的历史记录页面（不受菜单 20 条限制），放在「最近历史」上面
  create({
    id: 'history-all',
    title: '历史记录',
    contexts: ['action']
  });
  create({
    id: 'history-root',
    title: list.length ? `最近历史（${list.length}）` : '最近历史（空）',
    enabled: list.length > 0,
    contexts: ['action']
  });
  list.slice(0, HISTORY_MENU_MAX).forEach((rec, i) => {
    const t = String(rec.title || '无标题').trim() || '无标题';
    const a = String(rec.author || '').trim();
    const d = new Date(Number(rec.ts) || Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    let label = a ? `${t} · ${a}` : t;
    if (label.length > 24) label = label.slice(0, 24) + '…';
    create({
      id: `hist-${i}`,
      parentId: 'history-root',
      title: `${label}　${stamp}`,
      contexts: ['action']
    });
  });
}

// 串行化：onInstalled / storage.onChanged / 冷启动 同时触发会撞出 duplicate id
let menuQueue = Promise.resolve();
function scheduleRebuildMenus() {
  menuQueue = menuQueue
    .then(() => rebuildMenus())
    .catch((e) => console.error('[Background] 重建菜单失败:', e));
  return menuQueue;
}

chrome.runtime.onInstalled.addListener(scheduleRebuildMenus);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(scheduleRebuildMenus);
// 每次新增/删除历史（含清空）都重建一次菜单
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[HISTORY_KEY]) scheduleRebuildMenus();
});
// 冷启动时也重建一次（service worker 重启后菜单项不丢）
scheduleRebuildMenus();

// 最近一个普通网页标签页（历史页「在网页中重开预览」要把面板开到这里）
// service worker 会被回收，id 存进 storage.session 才不会丢
let lastContentTabId = null;

function rememberContentTab(tabId) {
  if (!tabId) return;
  lastContentTabId = tabId;
  try { chrome.storage.session.set({ lastContentTabId: tabId }); } catch (e) {}
}

async function getContentTabId() {
  if (lastContentTabId) {
    try { await chrome.tabs.get(lastContentTabId); return lastContentTabId; } catch (e) {}
  }
  try {
    const r = await chrome.storage.session.get(['lastContentTabId']);
    const saved = r && r.lastContentTabId;
    if (saved) {
      await chrome.tabs.get(saved);
      lastContentTabId = saved;
      return saved;
    }
  } catch (e) {}
  // 兜底：随便找一个非扩展页的普通标签页
  try {
    const tabs = await chrome.tabs.query({});
    const found = tabs.find((t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    if (found) { rememberContentTab(found.id); return found.id; }
  } catch (e) {}
  return null;
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then((t) => {
      if (t && t.url && !t.url.startsWith('chrome-extension://')) rememberContentTab(tabId);
    })
    .catch(() => {});
});

// 等标签页加载完成（最多 12 秒），等不到也继续
async function waitTabComplete(tabId, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return true;
    } catch (e) { return false; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// 某条记录该在哪个标签页里打开：
//  1) 记录里存了原网页 URL → 找寻那个网页（已开着就切过去，没开就新开一个），等加载完再注入；
//     原网页无法访问时：关掉刚新建的空标签，直接返回失败，绝不改到别的网页去开预览
//  2) 没有 URL 或 URL 不能注入（chrome://、edge:// 等）→ 也不乱开网页，直接失败
async function openRecordAnywhere(rec, preferTabId) {
  // 右键菜单是在某个页面点的：优先就在这个页面里开
  if (preferTabId) {
    try { await chrome.tabs.update(preferTabId, { active: true }); } catch (e) {}
    if (await sendHistoryRecord(preferTabId, rec)) return true;
  }
  const injectable = (u) => /^(http|https|file):\/\//.test(String(u || ''));
  if (!injectable(rec.url)) return false;
  let tab = null;
  let created = false;
  try {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => t && t.url === rec.url) || null;
  } catch (e) {}
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: rec.url, active: true });
      created = true;
    } catch (e) {}
  } else {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
  }
  if (!tab || !tab.id) return false;
  rememberContentTab(tab.id);
  const loaded = await waitTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 200));   // 给 content script 一点就位时间
  if (!loaded) {
    if (created) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
    return false;
  }
  if (await sendHistoryRecord(tab.id, rec)) return true;
  // 页面能开但注入不进去（错误页、登录跳转、受限页）：新建的标签页收掉，不换别的网页
  if (created) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  return false;
}

// 把一条历史记录发到指定标签页（没注入 content script 时先注入）
async function sendHistoryRecord(tabId, rec) {
  if (!tabId || !rec) return false;
  const msg = {
    action: 'OPEN_HISTORY_ITEM',
    record: {
      title: String(rec.title || ''),
      author: String(rec.author || ''),
      text: String(rec.text || '')
    }
  };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      setTimeout(() => { chrome.tabs.sendMessage(tabId, msg).catch(() => {}); }, 100);
      return true;
    } catch (e2) {
      console.error('[Background] 打开历史记录失败:', e2);
      return false;
    }
  }
}

// 打开历史记录里的一条：把标题/作者/正文重新灌进预览面板
async function openHistoryItem(idx, tab) {
  const local = await getLocal(HISTORY_KEY);
  const list = Array.isArray(local[HISTORY_KEY]) ? local[HISTORY_KEY] : [];
  const rec = list[idx];
  if (!rec) return;
  // 右键菜单是在某个标签页上点的：优先就用这个标签页
  await openRecordAnywhere(rec, tab && tab.id);
}

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'history-all') {
    chrome.tabs.create({ url: chrome.runtime.getURL('historypage.html') }).catch(() => {});
    return;
  }
  if (typeof info.menuItemId === 'string' && info.menuItemId.indexOf('hist-') === 0) {
    const idx = parseInt(info.menuItemId.slice(5), 10);
    if (!isNaN(idx)) openHistoryItem(idx, tab);
    return;
  }
  if (info.menuItemId !== 'toggle-smart-mode') return;

  chrome.storage.sync.get(['smartMode'], (result) => {
    const newState = !result.smartMode;
    chrome.storage.sync.set({ smartMode: newState });

    // 更新菜单标题显示状态
    scheduleRebuildMenus();

    // 向当前页面发送消息显示提示（与 content.js 内的模式说明保持一致）
    chrome.tabs.sendMessage(tab.id, {
      action: 'SHOW_TOAST',
      message: newState
        ? '🧠 智能模式已开启：第1行→标题，第2行→作者，其余→正文'
        : '📝 手动模式已开启：先选中标题/作者，再点击要提取的 DIV'
    }).catch(() => {
      // 忽略错误（可能没有 content script）
    });
  });
});