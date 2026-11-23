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
              return { supported: true, fonts: Array.from(set).sort(), aliases, error: null };
            }).catch(err => ({
              supported: true,
              fonts: [],
              aliases: {},
              error: String((err && err.name) || err)
            }));
          }
        });
        const r = (results && results[0] && results[0].result) || {};
        sendResponse({ success: true, supported: r.supported !== false, fonts: r.fonts || [], aliases: r.aliases || {}, error: r.error });
      } catch (e) {
        sendResponse({ success: false, fonts: [], error: e.message });
      }
    })();
    return true;
  }
});

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'toggle-smart-mode',
    title: '智能模式（自动识别标题/作者）',
    contexts: ['action']  // 右键点击扩展图标时显示
  });
});

// 监听右键菜单点击（切换智能模式）
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'toggle-smart-mode') return;

  chrome.storage.sync.get(['smartMode'], (result) => {
    const newState = !result.smartMode;
    chrome.storage.sync.set({ smartMode: newState });

    // 更新菜单标题显示状态
    const menuTitle = newState ? '✓ 智能模式（已开启）' : '智能模式（已关闭）';
    chrome.contextMenus.update('toggle-smart-mode', { title: menuTitle });

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