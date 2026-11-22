// 在页面主世界运行：读取本机字体列表（Local Font Access API）
// 结果通过 postMessage 回传给 content script
(function () {
  var send = function (fonts) {
    window.postMessage({ type: 'FJ_LOCAL_FONTS', fonts: fonts || [] }, '*');
  };

  if (typeof window.queryLocalFonts !== 'function') {
    send([]);
    return;
  }

  try {
    window.queryLocalFonts().then(function (faces) {
      var set = new Set();
      (faces || []).forEach(function (f) {
        var name = f && (f.fullName || f.family);
        if (name) set.add(name);
      });
      send(Array.from(set).sort());
    }).catch(function () {
      send([]);
    });
  } catch (e) {
    send([]);
  }
})();
