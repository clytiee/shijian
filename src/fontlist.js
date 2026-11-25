// 在页面主世界运行：读取本机字体列表（Local Font Access API）
// 结果通过 postMessage 回传给 content script
(function () {
  var send = function (fonts, aliases, faces) {
    window.postMessage({ type: 'FJ_LOCAL_FONTS', fonts: fonts || [], aliases: aliases || {}, faces: faces || [] }, '*');
  };

  if (typeof window.queryLocalFonts !== 'function') {
    send([]);
    return;
  }

  try {
    window.queryLocalFonts().then(function (faces) {
      // 以 family 为准：同一家族的多字重只显示一条（Bold/Regular 由正文加粗开关控制）
      var set = new Set();
      // 同时收集 fullName 作为别名：中文 family + 英文 fullName 的情况，搜英文也能命中
      var aliases = {};
      (faces || []).forEach(function (f) {
        var name = f && (f.family || f.fullName);
        if (!name) return;
        var key = String(name).trim();
        set.add(key);
        var extra = (f.fullName && String(f.fullName).trim() !== key) ? String(f.fullName).trim() : '';
        if (extra) {
          aliases[key] = aliases[key] || [];
          if (aliases[key].indexOf(extra) === -1) aliases[key].push(extra);
        }
      });
      // 原始元数据，供“全部字体”页展示
      var meta = (faces || []).map(function (f) {
        return {
          family: String((f && f.family) || '').trim(),
          fullName: String((f && f.fullName) || '').trim(),
          postscriptName: String((f && f.postscriptName) || '').trim(),
          style: String((f && f.style) || '').trim()
        };
      }).filter(function (f) { return f.family || f.fullName; });
      send(Array.from(set).sort(), aliases, meta);
    }).catch(function () {
      send([]);
    });
  } catch (e) {
    send([]);
  }
})();
