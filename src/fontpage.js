// 全部字体元数据页：照 demo 页的做法，直接 queryLocalFonts() 读本机字体，如实显示四字段
// 点「使用」写 fontFamily 并关闭本页，预览面板监听 storage 变更后应用
(function () {
  const STYLE_SUFFIX_RE = /[\s·\-_]*(常规体|常规|标准体|标准|粗体|细体|特粗|中粗|幼线|中等|粗|细|Regular|Normal|Book|Roman|Light|Medium|SemiBold|Semibold|DemiBold|Bold|ExtraBold|UltraBold|Heavy|Black|Thin|ExtraLight|UltraLight|Oblique|Italic|Condensed|Narrow|Wide)\s*$/i;
  const CJK_RE = /[\u3400-\u9fff]/;
  // 预览列用的示例句
  const SAMPLE = '元素图文';

  const tb = document.getElementById('tb');
  const cnt = document.getElementById('cnt');
  const srcEl = document.getElementById('src');
  const errEl = document.getElementById('err');
  const envEl = document.getElementById('env');
  const qInput = document.getElementById('q');
  const hideEnChk = document.getElementById('hide-en');

  // 常用 3500 字表（common3500.js 提供），用于 cmap 覆盖率检测
  const COMMON3500 = Array.from((window.FJ_COMMON3500 || '')).map(ch => ch.codePointAt(0));
  const COMMON_SET = new Set(COMMON3500);

  // 全部行（未分组），分组与排序在 layoutRows() 里生成 ROWS
  let ROWS = [];
  let DATA = [];
  const SORT = { key: '', dir: 1 };
  // cmap 检测结果：key -> { n: 命中常用字数, cjk: 汉字总数 }
  let AN = {};
  // 实时读取拿到的 FontData（只有它能 blob() 解析 cmap）
  let LIVE_FACES = [];
  // 排序分组用的名单（由预览页快照带过来，逻辑与插件里一致）
  let SORT_META = { tier1: [], foundries: [], latin: [] };

  document.getElementById('env').textContent = [
    'isSecureContext: ' + window.isSecureContext,
    'queryLocalFonts: ' + (typeof window.queryLocalFonts === 'function' ? '可用' : '不支持'),
    'navigator.language: ' + navigator.language,
    '界面语言: ' + (chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : '-')
  ].join(' · ');

  function stripStyle(name) {
    let s = String(name || '').trim();
    for (let i = 0; i < 4; i++) {
      const next = s.replace(STYLE_SUFFIX_RE, '').trim();
      if (next === s) break;
      s = next;
    }
    return s;
  }

  function displayName(family, fullName, aliases) {
    const fam = String(family || '').trim();
    const full = String(fullName || '').trim();
    if (CJK_RE.test(fam) && !aliases.some(a => a === fam)) return fam;
    const alts = aliases.map(stripStyle).filter(v => v && CJK_RE.test(v));
    if (CJK_RE.test(fam)) {
      const longer = alts.filter(v => v.length > fam.length && v.startsWith(fam));
      return longer.length ? longer[0] : fam;
    }
    if (!alts.length) return fam || full;
    return alts.slice().sort((a, b) => a.length - b.length)[0];
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 与插件 sortFontOptions 同样的 tier 判定：1 系统中文、2 字体厂商、3 其它、4 自带西文
  function matchLatinListed(name, list) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return false;
    return (list || []).some((en) => {
      const e = String(en).toLowerCase();
      if (lower === e || lower.startsWith(e)) return true;
      if (!e.startsWith(lower)) return false;
      const next = e.charAt(lower.length);
      return next === '' || next === ' ' || next === '-' || next === '_' || next === '.';
    });
  }

  function fontTier(name) {
    const lower = String(name || '').toLowerCase();
    const t1 = SORT_META.tier1 || [];
    if (t1.some(n => String(n).toLowerCase() === lower || lower.startsWith(String(n).toLowerCase()))) return 1;
    if (matchLatinListed(name, SORT_META.latin)) return 4;
    if ((SORT_META.foundries || []).some(p => lower.startsWith(String(p).toLowerCase()) || String(name).startsWith(p))) return 2;
    return 3;
  }

  // 分组：非自带西文字体一组（按 tier 排序），自带西文字体单独一组「英文字体」放最后
  function groupRows(rows) {
    const latin = rows.filter(r => fontTier(r.family) === 4);
    const others = rows.filter(r => fontTier(r.family) !== 4);
    others.sort((a, b) => {
      const ta = fontTier(a.family);
      const tb = fontTier(b.family);
      if (ta !== tb) return ta - tb;
      return String(a.display || a.family).localeCompare(String(b.display || b.family), 'zh-Hans-CN');
    });
    latin.sort((a, b) => String(a.family).localeCompare(String(b.family)));
    if (!latin.length) return others;
    return others.concat([{ group: '英文字体（Windows / Office / 设计软件自带）' }], latin);
  }

  function rowKey(r) {
    return r.postscriptName || (r.family + '|' + r.style);
  }

  function hanCell(r) {
    const a = AN[rowKey(r)];
    if (!a) return '<td class="han dim">—</td>';
    const pct = COMMON3500.length ? (a.n / COMMON3500.length * 100) : 0;
    const cls = pct >= 95 ? 'ok' : (pct >= 50 ? 'mid' : 'low');
    return '<td class="han ' + cls + '" title="常用3500 命中 ' + a.n + ' · 汉字总数 ' + a.cjk + '">' +
      pct.toFixed(0) + '%<span class="sub">' + a.n + '</span></td>';
  }

  function render(list) {
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">还没有数据，点上面的「读取系统字体」</td></tr>';
    } else {
      tb.innerHTML = list.map(r => {
        if (r.group) {
          return '<tr class="grp"><td colspan="8">' + esc(r.group) + '</td></tr>';
        }
        const famForCss = String(r.family || r.fullName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return (
        '<tr class="row">' +
        '<td class="mono">' + esc(r.family) + '</td>' +
        '<td>' + esc(r.fullName) + '</td>' +
        '<td class="disp">' + esc(r.display) + '</td>' +
        '<td class="sample" style="font-family:\'' + famForCss + '\', serif;">' + esc(SAMPLE) + '</td>' +
        '<td class="mono ps">' + esc(r.postscriptName) + '</td>' +
        '<td class="sty">' + esc(r.style) + '</td>' +
        hanCell(r) +
        '<td><button class="use" data-family="' + esc(r.family) + '" data-fullname="' + esc(r.fullName) + '">使用</button></td>' +
        '</tr>'
        );
      }).join('');
    }
    cnt.textContent = '共 ' + list.length + ' 条';
  }

  // 是否英文字体：优先用 cmap 结果（命中不到 100 字），没检测过就按名单分组判定
  function isEnglishRow(r) {
    const a = AN[rowKey(r)];
    if (a) return a.n < 100;
    return fontTier(r.family) === 4;
  }

  function dropEmptyGroups(list) {
    return list.filter((r, i) => {
      if (!r.group) return true;
      let j = i + 1;
      while (j < list.length && !list[j].group) j++;
      return (j - i) > 1;
    });
  }

  function applyFilter() {
    const q = qInput.value.trim().toLowerCase();
    const hideEn = !!(hideEnChk && hideEnChk.checked);
    let list = ROWS;
    if (hideEn) list = dropEmptyGroups(list.filter(r => r.group || !isEnglishRow(r)));
    if (q) list = list.filter(r => !r.group && [r.display, r.family, r.fullName, r.postscriptName, r.style].join(' ').toLowerCase().includes(q));
    render(list);
  }

  function build(meta, source) {
    const seen = new Set();
    const aliasesByFamily = {};
    meta.forEach(m => {
      const key = m.family || m.fullName;
      if (!key) return;
      const extra = (m.fullName && m.fullName !== key) ? m.fullName : null;
      if (extra) {
        aliasesByFamily[key] = aliasesByFamily[key] || [];
        if (aliasesByFamily[key].indexOf(extra) === -1) aliasesByFamily[key].push(extra);
      }
    });
    DATA = [];
    meta.forEach(m => {
      if (!m.family && !m.fullName) return;
      const key = [m.family, m.fullName, m.postscriptName, m.style].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      DATA.push({
        family: String(m.family || ''),
        fullName: String(m.fullName || ''),
        postscriptName: String(m.postscriptName || ''),
        style: String(m.style || ''),
        display: displayName(m.family, m.fullName, aliasesByFamily[m.family] || [])
      });
    });
    ROWS = layoutRows();
    srcEl.textContent = source;
    applyFilter();
    const cjk = ROWS.filter(r => !r.group && CJK_RE.test(r.fullName)).length;
    const total = ROWS.filter(r => !r.group).length;
    srcEl.textContent = source + ' · 含中文 fullName ' + cjk + ' / ' + total;
    errEl.textContent = '';
  }

  // 实时读取（需要用户手势）
  function readLive() {
    errEl.textContent = '';
    if (typeof window.queryLocalFonts !== 'function') {
      errEl.textContent = '当前环境不支持 queryLocalFonts';
      return;
    }
    cnt.textContent = '读取中…';
    window.queryLocalFonts().then((faces) => {
      LIVE_FACES = faces || [];
      const meta = (faces || []).map(f => ({
        family: f && f.family,
        fullName: f && f.fullName,
        postscriptName: f && f.postscriptName,
        style: f && f.style
      }));
      build(meta, '实时读取 ' + new Date().toLocaleTimeString());
      try {
        const set = new Set();
        const aliases = {};
        meta.forEach(m => {
          const key = m.family || m.fullName;
          if (!key) return;
          set.add(key);
          const extra = (m.fullName && m.fullName !== key) ? m.fullName : '';
          if (extra) {
            aliases[key] = aliases[key] || [];
            if (aliases[key].indexOf(extra) === -1) aliases[key].push(extra);
          }
        });
        chrome.storage.local.set({
          fontPageSnapshot: { faces: meta, at: Date.now(), tier1: SORT_META.tier1, foundries: SORT_META.foundries, latin: SORT_META.latin },
          fontCache: { fonts: Array.from(set), aliases: aliases, faces: meta, at: Date.now() }
        });
      } catch (e) {}
    }).catch((err) => {
      cnt.textContent = '';
      errEl.textContent = '读取失败：' + ((err && err.name) || '') + ' ' + ((err && err.message) || '');
    });
  }

  // ---------- cmap 解析 ----------
  function tagAt(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  function findCmap(dv) {
    let base = 0;
    if (dv.byteLength > 12 && tagAt(dv, 0) === 'ttcf') base = dv.getUint32(12);
    const numTables = dv.getUint16(base + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (rec + 16 > dv.byteLength) break;
      if (tagAt(dv, rec) === 'cmap') return dv.getUint32(rec + 8);
    }
    return 0;
  }

  // 取覆盖最全的子表：优先 format 12，其次 format 4
  function bestSubtable(dv, cmapOff) {
    const num = dv.getUint16(cmapOff + 2);
    let best = null;
    for (let i = 0; i < num; i++) {
      const rec = cmapOff + 4 + i * 8;
      if (rec + 8 > dv.byteLength) break;
      const off = cmapOff + dv.getUint32(rec + 4);
      if (off + 2 > dv.byteLength) continue;
      const fmt = dv.getUint16(off);
      const score = fmt === 12 ? 100 : (fmt === 4 ? 50 : 0);
      if (score && (!best || score > best.score)) best = { off, fmt, score };
    }
    return best;
  }

  function parseFormat4(dv, off, set) {
    const segX2 = dv.getUint16(off + 6);
    const seg = segX2 / 2;
    const endB = off + 14;
    const startB = endB + segX2 + 2;
    const deltaB = startB + segX2;
    const roB = deltaB + segX2;
    for (let i = 0; i < seg; i++) {
      const end = dv.getUint16(endB + i * 2);
      const start = dv.getUint16(startB + i * 2);
      const delta = dv.getUint16(deltaB + i * 2);
      const ro = dv.getUint16(roB + i * 2);
      if (start > end) continue;
      for (let c = start; c <= end && c <= 0xFFFF; c++) {
        if (c === 0xFFFF) continue;
        let g;
        if (ro === 0) {
          g = (c + delta) & 0xFFFF;
        } else {
          const addr = roB + i * 2 + ro + (c - start) * 2;
          if (addr + 2 > dv.byteLength) continue;
          const gi = dv.getUint16(addr);
          g = gi === 0 ? 0 : (gi + delta) & 0xFFFF;
        }
        if (g !== 0) set.add(c);
      }
    }
  }

  function parseFormat12(dv, off, set) {
    const nGroups = dv.getUint32(off + 12);
    for (let i = 0; i < nGroups; i++) {
      const g = off + 16 + i * 12;
      if (g + 12 > dv.byteLength) break;
      const s = dv.getUint32(g);
      const e = dv.getUint32(g + 4);
      if (s > e || e - s > 0xFFFFF) continue;
      for (let c = s; c <= e; c++) set.add(c);
    }
  }

  async function cmapOf(face) {
    if (!face || typeof face.blob !== 'function') return null;
    const blob = await face.blob();
    const dv = new DataView(await blob.arrayBuffer());
    const cmapOff = findCmap(dv);
    if (!cmapOff) return null;
    const sub = bestSubtable(dv, cmapOff);
    if (!sub) return null;
    const set = new Set();
    if (sub.fmt === 12) parseFormat12(dv, sub.off, set);
    else parseFormat4(dv, sub.off, set);
    let n = 0;
    for (const c of COMMON_SET) if (set.has(c)) n++;
    let cjk = 0;
    for (const c of set) {
      if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) cjk++;
    }
    return { n, cjk, chars: set.size };
  }

  function saveAn() {
    try {
      const out = {};
      Object.keys(AN).forEach(k => { out[k] = { n: AN[k].n, cjk: AN[k].cjk, chars: AN[k].chars }; });
      chrome.storage.local.set({ fontCmapCache: { map: out, at: Date.now() } });
    } catch (e) {}
  }

  // 逐个字体解析 cmap（需要用户手势；只用实时读取拿到的 FontData）
  async function analyzeAll() {
    errEl.textContent = '';
    if (!LIVE_FACES.length) {
      errEl.textContent = '请先点「读取系统字体」——cmap 检测必须在同一次读取拿到的字体对象上做';
      return;
    }
    const rows = ROWS.filter(r => !r.group);
    if (!rows.length) return;
    const btn = document.getElementById('btn-analyze');
    btn.disabled = true;
    let done = 0;
    let fail = 0;
    for (const r of rows) {
      const key = rowKey(r);
      if (AN[key]) { done++; continue; }
      const face = LIVE_FACES.find(f => (f.postscriptName || (f.family + '|' + f.style)) === key);
      if (!face) { done++; continue; }
      try {
        const res = await cmapOf(face);
        if (res) AN[key] = res;
        else fail++;
      } catch (e) {
        fail++;
      }
      done++;
      cnt.textContent = '检测中… ' + done + ' / ' + rows.length + '（失败 ' + fail + '）';
      if (done % 8 === 0) { render(ROWS); }
      await new Promise(res => setTimeout(res, 0));
    }
    btn.disabled = false;
    saveAn();
    ROWS = layoutRows();
    applyFilter();
    cnt.textContent = '共 ' + rows.length + ' 条 · 检测完成，失败 ' + fail;
  }

  // 排序：按当前列在各自分组内部重排；「常用字」按命中数，未知放末尾
  function sortValue(r, key) {
    if (key === 'han') {
      const a = AN[rowKey(r)];
      return a ? a.n : -1;
    }
    return String(r[key] || '');
  }

  function compareRows(a, b) {
    if (SORT.key === 'han') {
      const va = sortValue(a, 'han');
      const vb = sortValue(b, 'han');
      if (va !== vb) return (va - vb) * SORT.dir;
      return String(a.display || '').localeCompare(String(b.display || ''), 'zh-Hans-CN');
    }
    return sortValue(a, SORT.key).localeCompare(sortValue(b, SORT.key), 'zh-Hans-CN') * SORT.dir;
  }

  function sortGroups(list) {
    if (!SORT.key) return list;
    const out = [];
    let seg = [];
    const flush = () => {
      if (seg.length) { seg.sort(compareRows); out.push.apply(out, seg); seg = []; }
    };
    list.forEach(item => {
      if (item.group) { flush(); out.push(item); }
      else seg.push(item);
    });
    flush();
    return out;
  }

  function layoutRows() {
    return sortGroups(groupRows(DATA));
  }

  function syncHeader() {
    document.querySelectorAll('th.sortable').forEach(th => {
      const on = th.dataset.sort === SORT.key;
      th.classList.toggle('sorted', on);
      const arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = on ? (SORT.dir > 0 ? '▲' : '▼') : '';
    });
  }

  function initSort() {
    document.querySelectorAll('th.sortable').forEach(th => {
      if (!th.querySelector('.arrow')) {
        const sp = document.createElement('span');
        sp.className = 'arrow';
        th.appendChild(sp);
      }
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (SORT.key === key) SORT.dir = -SORT.dir;
        else { SORT.key = key; SORT.dir = 1; }
        ROWS = layoutRows();
        syncHeader();
        applyFilter();
      });
    });
    syncHeader();
  }

  tb.addEventListener('click', (ev) => {
    const btn = ev.target.closest ? ev.target.closest('button.use') : null;
    if (!btn) return;
    const name = (btn.dataset.family || btn.dataset.fullname || '').trim();
    if (!name) return;
    try { chrome.storage.local.set({ fontFamily: name }); } catch (e) {}
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'FJ_FONT_PICK', name: name }, '*');
      }
    } catch (e) {}
    // 后台用 chrome.tabs.create 打开的标签页不能被 window.close() 关掉，走 tabs.remove
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id != null) chrome.tabs.remove(tab.id);
        else window.close();
      });
    } catch (e) {
      window.close();
    }
  });

  // 打开时先用上次快照把表填上（不自动实读，避免覆盖中文名）
  try {
    chrome.storage.local.get(['fontPageSnapshot', 'fontCache', 'fontCmapCache'], (r) => {
      const snap = r && r.fontPageSnapshot;
      const cache = r && r.fontCache;
      const cmapCache = r && r.fontCmapCache;
      if (cmapCache && cmapCache.map) AN = cmapCache.map;
      if (snap) {
        SORT_META = {
          tier1: Array.isArray(snap.tier1) ? snap.tier1 : SORT_META.tier1,
          foundries: Array.isArray(snap.foundries) ? snap.foundries : SORT_META.foundries,
          latin: Array.isArray(snap.latin) ? snap.latin : SORT_META.latin
        };
      }
      const faces = (snap && Array.isArray(snap.faces) && snap.faces.length) ? snap.faces
        : (cache && Array.isArray(cache.faces) ? cache.faces : []);
      if (faces.length) {
        const when = new Date(Number((snap && snap.at) || (cache && cache.at) || 0)).toLocaleString();
        build(faces.map(f => ({ family: f.family, fullName: f.fullName, postscriptName: f.postscriptName, style: f.style })), '上次快照 ' + when);
      } else {
        render([]);
      }
    });
  } catch (e) {
    render([]);
  }

  initSort();
  document.getElementById('btn-read').addEventListener('click', readLive);
  document.getElementById('btn-analyze').addEventListener('click', analyzeAll);
  qInput.addEventListener('input', applyFilter);
  if (hideEnChk) hideEnChk.addEventListener('change', applyFilter);
})();
