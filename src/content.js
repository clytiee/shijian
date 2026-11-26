// content.js - 完整版，包含竖排文字、可编辑标题、纯净截图、题记格式、布局模式、行距调整
let html2canvasLoaded = false;
let html2canvasLoading = false;
let html2canvasQueue = [];

let isSelectionMode = false;
let savedSelectedText = '';
let savedSubtitleText = '';
let currentHighlightedElement = null;

let currentLineHeight = 2.0;
let currentFontSize = 14;   // pt
let currentFontFamily = '方正金陵';
let currentMarginMm = 8;    // 页边距（mm）
let currentGutterMm = 0;    // 装订线：额外加在装订侧（内侧）的边距（mm）
let currentBold = false;    // 正文是否加粗
let currentBodyColor = '';  // 正文颜色（空=默认）
let currentLetterSpacing = 0;   // 字间距（px，竖排时沿列方向的字与字间距）

let currentColumnCount = 0;
let horiAlign = 'center';

// ========== 1. 内嵌 html2canvas 精简版 ==========
(function() {
  if (typeof window.html2canvas !== 'undefined') return;
  window.html2canvas = function(element, options) {
    options = options || {};
    const scale = options.scale || 1;
    const backgroundColor = options.backgroundColor || '#ffffff';
    
    return new Promise((resolve, reject) => {
      try {
        const clone = element.cloneNode(true);
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const data = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;">${clone.outerHTML}</div></foreignObject></svg>`;
        
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, width * scale, height * scale);
          resolve(canvas);
        };
        img.onerror = reject;
        img.src = 'data:image/svg+xml,' + encodeURIComponent(data);
      } catch (e) {
        reject(e);
      }
    });
  };
})();


// 创建高亮样式
const styleId = 'gufeng-highlight-style';
if (!document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .fj-extractor-highlight {
      outline: 3px solid #3b82f6 !important;
      outline-offset: 2px !important;
      cursor: pointer !important;
      transition: outline 0.1s ease !important;
      box-shadow: 0 0 0 2px rgba(59,130,246,0.3) !important;
      background-color: rgba(59,130,246,0.2) !important;
    }
  `;
  document.head.appendChild(style);
}

function clearHighlight() {
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove('fj-extractor-highlight');
    currentHighlightedElement = null;
  }
}

function onMouseOver(event) {
  if (!isSelectionMode) return;
  
  let target = event.target;
  while (target && target !== document.body && target.tagName !== 'DIV') {
    target = target.parentElement;
  }
  if (!target || target === document.body) return;
  
  if (currentHighlightedElement === target) return;
  
  clearHighlight();
  currentHighlightedElement = target;
  currentHighlightedElement.classList.add('fj-extractor-highlight');
}

function onMouseOut(event) {
  if (!isSelectionMode) return;
  setTimeout(() => {
    if (currentHighlightedElement && !currentHighlightedElement.matches(':hover')) {
      clearHighlight();
    }
  }, 50);
}


function onClickHandler(event) {
  if (!isSelectionMode) return;
  
  // 获取目标 DIV
  let targetDiv = event.target;
  while (targetDiv && targetDiv !== document.body && targetDiv.tagName !== 'DIV') {
    targetDiv = targetDiv.parentElement;
  }
  if (!targetDiv || targetDiv === document.body) {
    showToast('⚠️ 请点击 DIV 元素', 1200);
    return;
  }
  
  event.preventDefault();
  event.stopPropagation();
  
  const extractedText = extractTextFromDiv(targetDiv);
  
  if (!extractedText || extractedText.trim() === '') {
    showToast('⚠️ 所选 div 内没有可提取的文字', 1500);
    return;
  }
  
  // 获取智能模式状态
  chrome.storage.sync.get(['smartMode'], (result) => {
    const smartMode = result.smartMode || false;
    let title = savedSelectedText;
    let subtitle = savedSubtitleText;
    
    if (smartMode) {
      // 智能模式：从提取的文字中解析第一行和第二行
      const lines = extractedText.split(/\n/).filter(line => line.trim() !== '');
      if (lines.length >= 2) {
        title = lines[0].trim();
        // 第二行短（≤20 字）才当朝代/作者，超长的归入正文，不能丢
        let bodyFrom = 1;
        if (lines[1].length <= 20) {
          subtitle = lines[1].trim();
          bodyFrom = 2;
        } else {
          subtitle = '';
        }
        const bodyText = lines.slice(bodyFrom).join('\n');
        showA5FloatingPanel(bodyText, title, subtitle);
      } else if (lines.length === 1) {
        title = lines[0].trim();
        subtitle = '';
        showA5FloatingPanel('', title, subtitle);
      } else {
        showA5FloatingPanel(extractedText, title, subtitle);
      }
    } else {
      // 手动模式：使用用户选中的文字作为标题
      showA5FloatingPanel(extractedText, title, subtitle);
    }
  });
  
  cancelMode();
}

function extractTextFromDiv(divElement) {
  const clone = divElement.cloneNode(true);
  const scripts = clone.querySelectorAll('script, style, noscript, iframe');
  scripts.forEach(el => el.remove());
  
  let text = '';
  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      // 只追加可见文字：HTML 源码里的换行/缩进属于排版空白，不能当成换行
      // （\u3000 全角空格是正文缩进，需保留）
      text += node.textContent.replace(/[ \t\r\n\f]+/g, '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'section', 'article', 'blockquote'];
      if (blockTags.includes(tagName)) {
        if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      }
      for (const child of node.childNodes) {
        traverse(child);
      }
      if (blockTags.includes(tagName)) {
        if (!text.endsWith('\n')) text += '\n';
      }
    }
  }
  traverse(clone);
  
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');

  // 【修改】只去除空格和制表符，保留换行
  text = text.replace(/[ \t]+/g, '');

  text = text.trim();
  
  return text;
}

// 切列时不能出现在列首的标点
const COLUMN_PUNCT = '，。、！？：；…·—－”’）】》〉」』〕｝］"' + ',.;:!?)]}%‰';

// 按列切字：如果切点后面的字符是标点，就把它并入本列，避免标点落在列首
function sliceColumnText(text, maxChars) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + maxChars);
    while (end < text.length && COLUMN_PUNCT.indexOf(text[end]) !== -1) end++;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

// 打印图片函数
async function printImage(panelElement, contentElement, titleValue) {
  try {
    // 保存当前滚动位置
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    
    // 保存并隐藏工具栏和按钮
    const originalCloseBtn = panelElement.querySelector('#fj-close-panel');
    const originalFooter = panelElement.querySelector('.fj-footer');
    const originalToolbar = panelElement.querySelector('.fj-title-toolbar');
    const originalEpigraphToolbar = panelElement.querySelector('.fj-epigraph-toolbar');
    const originalLayoutToolbar = panelElement.querySelector('.fj-layout-toolbar');
    const originalLineHeightToolbar = panelElement.querySelector('.fj-lineheight-toolbar');
    
    const originalCloseDisplay = originalCloseBtn?.style.display;
    const originalFooterDisplay = originalFooter?.style.display;
    const originalToolbarDisplay = originalToolbar?.style.display;
    const originalEpigraphDisplay = originalEpigraphToolbar?.style.display;
    const originalLayoutDisplay = originalLayoutToolbar?.style.display;
    const originalLineHeightDisplay = originalLineHeightToolbar?.style.display;
    
    if (originalCloseBtn) originalCloseBtn.style.display = 'none';
    if (originalFooter) originalFooter.style.display = 'none';
    if (originalToolbar) originalToolbar.style.display = 'none';
    if (originalEpigraphToolbar) originalEpigraphToolbar.style.display = 'none';
    if (originalLayoutToolbar) originalLayoutToolbar.style.display = 'none';
    if (originalLineHeightToolbar) originalLineHeightToolbar.style.display = 'none';

    // 获取纸张大小设置
    const paperSizeSelect = document.getElementById('fj-paper-size');
    let paperSize = 'A5';
    if (paperSizeSelect) {
      paperSize = paperSizeSelect.value;
    }

    // 获取用户选择的打印方向
    const orientationRadio = document.querySelector('input[name="layout-mode"]:checked');
    let orientation = 'portrait';
    if (orientationRadio) {
        orientation = orientationRadio.value;
    }
    console.log("[DEBUG] 设置的打印方向：", orientationRadio.value);
    /*
    // 根据方向设置纸张
    const pageSize = orientation === 'portrait' ? 'A5 portrait' : 'A5 landscape';
    */
    // 根据纸张大小和方向设置页面尺寸
    let pageSize = '';
    if (paperSize === 'A5') {
      pageSize = orientation === 'portrait' ? 'A5 portrait' : 'A5 landscape';
    } else {
      pageSize = orientation === 'portrait' ? 'A4 portrait' : 'A4 landscape';
    }
    
    console.log('currentColumnCount:', currentColumnCount);

    // ===== 打印 = 直接克隆预览页：同一份 DOM、同一份样式，不再另写一套 CSS =====
    const pagesEl = panelElement ? panelElement.querySelector('.fj-pages') : null;
    if (!pagesEl || !pagesEl.children.length) {
      if (originalCloseBtn) originalCloseBtn.style.display = originalCloseDisplay || '';
      if (originalFooter) originalFooter.style.display = originalFooterDisplay || '';
      if (originalToolbar) originalToolbar.style.display = originalToolbarDisplay || '';
      if (originalEpigraphToolbar) originalEpigraphToolbar.style.display = originalEpigraphDisplay || '';
      showToast('❌ 还没有生成预览页，无法打印', 2000);
      return;
    }
    const pagesHtml = Array.from(pagesEl.children).map((n) => n.outerHTML).join('');

    // 纸张尺寸（mm），仅用于 @page 声明
    const paperMm = PAPER_MM[paperSize] || PAPER_MM.A5;
    let pageWmm = paperMm.w;
    let pageHmm = paperMm.h;
    if (orientation === 'landscape') {
      const t = pageWmm;
      pageWmm = pageHmm;
      pageHmm = t;
    }

    // 面板里那份样式原样带过去（预览/打印共用同一套 CSS）
    const animCss = (document.getElementById('fj-anim-style') || {}).textContent || '';

    // 只追加“打印窗口独有”的少量规则：纸张声明、分页、屏幕预览外观
    const printOnlyCss = `
      @page { size: ${pageWmm}mm ${pageHmm}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body {
        background: #fff;
        font-family: '${currentFontFamily}', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .fj-pages { display: block; padding: 0; gap: 0; }
      .fj-page { margin: 0 auto; box-shadow: none !important; page-break-after: always; break-after: page; }
      .fj-page:last-child { page-break-after: auto; break-after: auto; }
      @media screen {
        body { padding: 10mm; background: #e5e7eb; }
        .fj-page { margin: 0 auto 8mm; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15) !important; }
      }
    `;
    console.log(`[DEBUG] 打印页数: ${pagesEl.children.length}`);

    // 创建打印窗口
    const printHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${escapeHtml(titleValue)} - 元素图文·时见</title>
        <meta charset="UTF-8">
        <style>
          ${animCss}
          ${printOnlyCss}
        </style>
      </head>
      <body>
        <div class="fj-pages">${pagesHtml}</div>
      </body>
      </html>
    `;

    // 打印窗口用 about:blank（blob: 隔离在某些插件下仍被注入，已改回）
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('❌ 打印窗口被拦截，请允许站点弹出窗口后重试', 2500);
      return;
    }
    printWindow.document.write(printHtml);
    printWindow.document.close();
    
    // ========== 这里是你要加的位置 ==========
    // 等待内容加载完成后触发打印
    printWindow.onload = () => {
      setTimeout(() => {
        // 监听窗口获得焦点（打印对话框关闭后，原窗口会重新获得焦点）
        const handleFocus = () => {
          setTimeout(() => {
            if (!printWindow.closed) {
              printWindow.close();
            }
          }, 100);
          printWindow.removeEventListener('focus', handleFocus);
        };
        
        printWindow.addEventListener('focus', handleFocus);
        
        // 触发打印
        printWindow.print();
        
        // 关闭打印窗口
        // 备用方案：如果 onafterprint 支持，同时使用
        printWindow.onafterprint = () => {
          setTimeout(() => {
            if (!printWindow.closed) {
              printWindow.close();
            }
          }, 100);
        };
        
        // 超时保护：5秒后强制关闭
        setTimeout(() => {
          if (!printWindow.closed) {
            printWindow.close();
          }
        }, 15000);
        
      }, 300);
    };
    // ========== 上面的代码块加在这里 ==========
    
    // 恢复工具栏显示
    if (originalCloseBtn) originalCloseBtn.style.display = originalCloseDisplay || '';
    if (originalFooter) originalFooter.style.display = originalFooterDisplay || '';
    if (originalToolbar) originalToolbar.style.display = originalToolbarDisplay || '';
    if (originalEpigraphToolbar) originalEpigraphToolbar.style.display = originalEpigraphDisplay || '';
    if (originalLayoutToolbar) originalLayoutToolbar.style.display = originalLayoutDisplay || '';
    if (originalLineHeightToolbar) originalLineHeightToolbar.style.display = originalLineHeightDisplay || '';
    
    window.scrollTo(originalScrollX, originalScrollY);
    
    showToast('🖨️ 打印窗口已打开，默认无页眉页脚', 1500);
  } catch (error) {
    console.error('打印失败:', error);
    showToast('❌ 打印失败', 1500);
    window.scrollTo(originalScrollX, originalScrollY);
  }
}

//下载图片函数
// ========== 2. 下载图片：把预览里的每一页（与打印同源的 .fj-page）整张渲染成 PNG ==========
// 旧的 captureAndDownload 用 captureVisibleTab 截当前视口，内容高于屏幕就会被截断，这里改为按页渲染
function renderElementToCanvas(element, scale = 2) {
  return new Promise((resolve, reject) => {
    try {
      const css = Array.from(document.querySelectorAll('style'))
        .filter(s => s.id === 'fj-anim-style')
        .map(s => s.textContent)
        .join('\n');
      const w = Math.ceil(element.scrollWidth);
      const h = Math.ceil(element.scrollHeight);
      const clone = element.cloneNode(true);
      clone.style.cssText = (clone.style.cssText || '') + ';margin:0;padding:0;background:#fff;';

      const xml = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;margin:0;padding:0;background:#fff;"><style><![CDATA[
${css}
.fj-page,.print-page{box-shadow:none !important;}
]]></style>${xml}</div></foreignObject></svg>`;

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('页面渲染失败'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch (e) {
      reject(e);
    }
  });
}

function downloadCanvas(canvas, titleValue, suffix = '') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  let safeTitle = (titleValue || '').replace(/[\\/:*?"<>|]/g, '-').trim();
  if (safeTitle.length > 30) safeTitle = safeTitle.substring(0, 30);
  if (!safeTitle) safeTitle = '无标题';
  const link = document.createElement('a');
  link.download = `${safeTitle}${suffix}-${timestamp}.png`;
  link.href = canvas.toDataURL('image/png', 1.0);
  link.click();
}

// 返回 true 表示已成功导出；false 时调用方回退到旧的截图方案
async function downloadPagesImage(pagesElement, titleValue) {
  try {
    if (!pagesElement || !pagesElement.querySelector('.fj-page')) return false;
    showToast('🖼 正在生成图片…', 1200);
    const canvas = await renderElementToCanvas(pagesElement, 2);
    downloadCanvas(canvas, titleValue);
    showToast('✅ 图片已保存', 1500);
    return true;
  } catch (e) {
    console.warn('[图片] 分页渲染失败，回退到截图方案：', e);
    return false;
  }
}

async function captureAndDownload(panelElement, contentElement, titleValue) {
  try {
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // 【新增】保存并隐藏横向滚动条
    const verticalContent = contentElement.querySelector('.vertical-content');
    const originalOverflowX = verticalContent ? verticalContent.style.overflowX : '';
    const originalOverflowY = verticalContent ? verticalContent.style.overflowY : '';
    if (verticalContent) {
      verticalContent.style.overflowX = 'hidden';  // 临时隐藏滚动条
      verticalContent.style.overflowY = 'hidden';
    }
    
    const originalCloseBtn = panelElement.querySelector('#fj-close-panel');
    const originalFooter = panelElement.querySelector('.fj-footer');
    const originalToolbar = panelElement.querySelector('.fj-title-toolbar');
    const originalEpigraphToolbar = panelElement.querySelector('.fj-epigraph-toolbar');
    const originalLayoutToolbar = panelElement.querySelector('.fj-layout-toolbar');
    const originalLineHeightToolbar = panelElement.querySelector('.fj-lineheight-toolbar');
    
    const originalCloseDisplay = originalCloseBtn?.style.display;
    const originalFooterDisplay = originalFooter?.style.display;
    const originalToolbarDisplay = originalToolbar?.style.display;
    const originalEpigraphDisplay = originalEpigraphToolbar?.style.display;
    const originalLayoutDisplay = originalLayoutToolbar?.style.display;
    const originalLineHeightDisplay = originalLineHeightToolbar?.style.display;
    
    if (originalCloseBtn) originalCloseBtn.style.display = 'none';
    if (originalFooter) originalFooter.style.display = 'none';
    if (originalToolbar) originalToolbar.style.display = 'none';
    if (originalEpigraphToolbar) originalEpigraphToolbar.style.display = 'none';
    if (originalLayoutToolbar) originalLayoutToolbar.style.display = 'none';
    if (originalLineHeightToolbar) originalLineHeightToolbar.style.display = 'none';
    
    const cloneContainer = document.createElement('div');
    cloneContainer.id = 'fj-clone-container';
    cloneContainer.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: ${contentElement.offsetWidth}px;
      background: white;
      z-index: 999999;
      font-family: '${currentFontFamily}', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif;
    `;
    
    const contentClone = contentElement.cloneNode(true);
    contentClone.style.cssText = `
      padding: 20px 20px;
      background: white;
      margin: 0;
    `;
    
    cloneContainer.appendChild(contentClone);
    document.body.appendChild(cloneContainer);
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const devicePixelRatio = window.devicePixelRatio || 1;
    const rect = cloneContainer.getBoundingClientRect();
    
    const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_PANEL' });
    
    if (response && response.success) {
      const img = new Image();
      img.onload = () => {
        const scaleX = img.width / window.innerWidth;
        const scaleY = img.height / window.innerHeight;
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        canvas.width = rect.width * devicePixelRatio;
        canvas.height = rect.height * devicePixelRatio;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        
        ctx.scale(devicePixelRatio, devicePixelRatio);
        
        ctx.drawImage(
          img,
          rect.left * scaleX, rect.top * scaleY,
          rect.width * scaleX, rect.height * scaleY,
          0, 0, rect.width, rect.height
        );
        
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        
        let safeTitle = titleValue.replace(/[\\/:*?"<>|]/g, '-').trim();
        if (safeTitle.length > 30) safeTitle = safeTitle.substring(0, 30);
        if (!safeTitle) safeTitle = '无标题';
        
        link.download = `${safeTitle}-方正金陵-${timestamp}.png`;
        link.href = canvas.toDataURL('image/png', 1.0);
        link.click();
        
        cloneContainer.remove();
        
        if (originalCloseBtn) originalCloseBtn.style.display = originalCloseDisplay || '';
        if (originalFooter) originalFooter.style.display = originalFooterDisplay || '';
        if (originalToolbar) originalToolbar.style.display = originalToolbarDisplay || '';
        if (originalEpigraphToolbar) originalEpigraphToolbar.style.display = originalEpigraphDisplay || '';
        if (originalLayoutToolbar) originalLayoutToolbar.style.display = originalLayoutDisplay || '';
        if (originalLineHeightToolbar) originalLineHeightToolbar.style.display = originalLineHeightDisplay || '';
        
        window.scrollTo(originalScrollX, originalScrollY);
        
        const tempToast = document.createElement('div');
        tempToast.textContent = '✅ 图片已保存';
        tempToast.style.cssText = `
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #1e293b;
          color: white;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 0.8rem;
          z-index: 10000000;
          font-family: system-ui;
        `;
        document.body.appendChild(tempToast);
        setTimeout(() => tempToast.remove(), 1500);
      };
      img.src = response.dataUrl;
    } else {
      throw new Error('截图失败');
    }
  } catch (error) {
    console.error('截图失败:', error);
    const clone = document.getElementById('fj-clone-container');
    if (clone) clone.remove();
    
    const originalCloseBtn = panelElement?.querySelector('#fj-close-panel');
    const originalFooter = panelElement?.querySelector('.fj-footer');
    const originalToolbar = panelElement?.querySelector('.fj-title-toolbar');
    if (originalCloseBtn) originalCloseBtn.style.display = '';
    if (originalFooter) originalFooter.style.display = '';
    if (originalToolbar) originalToolbar.style.display = '';
    window.scrollTo(originalScrollX, originalScrollY);
    
    const errorToast = document.createElement('div');
    errorToast.textContent = '❌ 截图失败';
    errorToast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #dc2626;
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.8rem;
      z-index: 10000000;
      font-family: system-ui;
    `;
    document.body.appendChild(errorToast);
    setTimeout(() => errorToast.remove(), 1500);
  }
}

// 纸张尺寸（mm）
const PAPER_MM = { A5: { w: 148, h: 210 }, A4: { w: 210, h: 297 } };
const PRINT_MARGIN_MM = 8;          // 打印页边距
const PX_PER_MM = 96 / 25.4;       // 打印按 96dpi 计算

// 测量竖排下一个字沿列方向的实际占高（px），受字号、行距、字体影响
function measureCharAdvance(fontSize = '14pt', lineHeight = 1.5) {
  const probe = document.createElement('div');
  probe.textContent = '国'.repeat(20);
  probe.style.cssText = `position:absolute;left:-9999px;top:0;writing-mode:vertical-rl;text-orientation:upright;font-size:${fontSize};line-height:${lineHeight};letter-spacing:${typeof currentLetterSpacing !== 'undefined' ? currentLetterSpacing : 0}px;white-space:nowrap;font-family:'${typeof currentFontFamily !== 'undefined' ? currentFontFamily : '方正金陵'}','FZJinL-B_GBJF','华文楷书','KaiTi','宋体',serif;`;
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h > 0 ? h / 20 : 18.7;
}

// ========== 仿古纸底纹 ==========
let currentAntiquePaper = false;
let antiquePaperTileUrl = '';

// 旧纸纹理：改成矢量 SVG（feTurbulence 的颗粒 + 横向纸纤维），不再每次跑 canvas
// 直接内联成 data URI，预览 / 打印 / 导图三处都能用，不依赖扩展资源路径
function buildAntiquePaperSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="7" result="noise"/>
    <feColorMatrix type="saturate" values="0" in="noise" result="mono"/>
    <feComponentTransfer in="mono" result="speck">
      <feFuncA type="linear" slope="0.13" intercept="0"/>
    </feComponentTransfer>
    <feComposite in="speck" in2="SourceAlpha" operator="in"/>
  </filter>
  <rect x="0" y="0" width="220" height="220" fill="#7a5f33" filter="url(#grain)"/>
  <g stroke="#967848" stroke-opacity="0.05" fill="none">
    <path d="M0 38 C55 34, 165 42, 220 37" stroke-width="1.4"/>
    <path d="M0 96 C60 101, 160 90, 220 97" stroke-width="1"/>
    <path d="M0 152 C50 148, 170 156, 220 151" stroke-width="1.6"/>
    <path d="M0 188 C58 193, 162 184, 220 189" stroke-width="0.9"/>
  </g>
</svg>`;
}

function getAntiquePaperTile() {
  if (antiquePaperTileUrl) return antiquePaperTileUrl;
  antiquePaperTileUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildAntiquePaperSvg());
  return antiquePaperTileUrl;
}

// 页面底纹样式：米色底 + 斑纹平铺 + 四边轻微泛黄（用渐变而非 box-shadow，保证打印/导图都能带上）
function antiquePaperBackground() {
  const tile = getAntiquePaperTile();
  return `background-color:#f7f0de;background-image:radial-gradient(circle at 50% 45%, rgba(255,255,255,0) 50%, rgba(118,88,48,0.16) 100%), url("${tile}");background-size:cover, 220px 220px;background-repeat:no-repeat, repeat;`;
}

// ========== 古籍版框（淡墨双线边框 + 界行） ==========
let currentAntiqueFrame = false;
const FRAME_GAP_MM = 2.6;    // 列间距，须与分页时的 GAP_MM 一致
const FRAME_PAD_X_MM = 2.6;  // 版框左右留白
const FRAME_PAD_Y_MM = 4.0;  // 版框上下留白
const FRAME_INK = '#000';        // 外框墨色（深一些）
const FRAME_INK_THIN = '#000';   // 内侧细线与界行
const FRAME_INNER_INSET_PX = 8;     // 内侧细线相对外框的内缩距离（≈2.1mm，做了旧也不会贴在一起）

// 阿拉伯数字转中文数字（用于页码）
function toChineseNumeral(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return '零';
  if (n < 10) return d[n];
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
  if (n < 100) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    return d[t] + '十' + (u ? d[u] : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return d[h] + '百' + (rest ? (rest < 10 ? '零' : '') + toChineseNumeral(rest) : '');
  }
  return String(n);
}

let currentPageNumber = false;
let currentPageNumberMirror = false;   // 奇偶页对称：奇数页码在左、偶数页码在右
let currentFrameFullPage = false;      // 版框「满页」：剩余宽度平摊给各列，框横向满版心
let currentFrameRough = false;         // 版框「做旧」：线条加手工刻版式抖动、界行断续
const PN_COL_W_MM = 4.2;               // 页码所占的那一列宽度（用于对称时扣减页边距）

// 页码落在哪一侧：未开对称时始终在左
function pageNoSide(pageNo) {
  if (!currentPageNumberMirror) return 'left';
  return (Number(pageNo) % 2 === 1) ? 'left' : 'right';
}

// 每页的左右页边距（mm）
// 基础左右相等；装订线额外加在装订侧（内侧）：
//   奇偶对称开 → 页码在外侧，装订侧与页码相对（奇数页装订在右、偶数页装订在左）
//   奇偶对称关 → 装订线固定在左侧（单面装订的常规做法）
function pageMargins(pageNo) {
  const base = currentMarginMm;
  const gutter = Math.max(0, Number(currentGutterMm) || 0);
  if (!gutter) return { left: base, right: base };
  const mirror = !!currentPageNumberMirror;
  const odd = mirror
    ? { left: base, right: base + gutter }       // 奇数页：页码在左、装订在右
    : { left: base + gutter, right: base };
  if (!mirror) return odd;
  return (Number(pageNo) % 2 === 1) ? odd : { left: odd.right, right: odd.left };
}

// 装订线占掉的版心宽度（两侧各页总和一致，分页可直接扣）
function gutterTotalWmm() {
  return Math.max(0, Number(currentGutterMm) || 0);
}

// 把一页的列宽铺满整个版心：字号变大导致列数减少、右侧还剩空白时，
// 把剩余宽度均摊给各列（相当于把行距略微放宽），使版心左右两边都不留宽窄不一的空白
function fillPageWidth(pageCols, innerWmm, gapMm) {
  const n = pageCols.length;
  if (!n) return;
  let usedPx = 0;
  pageCols.forEach((c) => { usedPx += c.widthPx; });
  usedPx += (n - 1) * gapMm * PX_PER_MM;
  const extraPx = innerWmm * PX_PER_MM - usedPx;
  if (extraPx > 0.5) {
    const each = extraPx / n;
    pageCols.forEach((c) => { c.widthPx += each; });
  }
  // 列宽变化后重算每列相对版心右缘的偏移
  let acc = 0;
  pageCols.forEach((c) => {
    c.rightMm = acc / PX_PER_MM;
    acc += c.widthPx + gapMm * PX_PER_MM;
  });
}

// ========== 古籍刻本「做旧」线条 ==========
// 确定性伪随机（mulberry32）：同一页每次渲染、打印、导出图片都得到同样的抖动，
// 不会出现“每刷一次线就换位置”或“预览和打印不一样”
function fjRoughRand(seed) {
  let s = (Number(seed) || 1) >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 沿直线取样，在法向上加抖动，模拟手工刻版画出的线不是笔直的
function fjRoughLine(x1, y1, x2, y2, amp, rand) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 2) return `M${x1} ${y1}L${x2} ${y2}`;
  const nx = -(y2 - y1) / len;   // 法向单位向量
  const ny = (x2 - x1) / len;
  const step = 4;
  const n = Math.max(2, Math.round(len / step));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    const w = (i === 0 || i === n) ? 0 : (rand() * 2 - 1) * amp;
    d += (i === 0 ? 'M' : 'L') + (px + nx * w).toFixed(2) + ' ' + (py + ny * w).toFixed(2);
  }
  return d;
}

// 低频起伏的长波：整条边只有几个控制点（长波长），用 Catmull-Rom 转贝塞尔平滑过渡，
// 模拟木刻长边整体的轻微弯曲，而不是高频抖动
function fjWavePath(x1, y1, x2, y2, amp, segs, rand) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 2) return `M${x1} ${y1}L${x2} ${y2}`;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const n = Math.max(2, segs);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // 两端钉死，中间按长波起伏（偏正弦的随机相位，避免看起来像折线）
    const w = (i === 0 || i === n) ? 0 : amp * Math.sin((rand() * 0.8 + 0.6) * Math.PI * t + rand() * 2) - (rand() * 2 - 1) * amp * 0.3;
    pts.push([x1 + (x2 - x1) * t + nx * w, y1 + (y2 - y1) * t + ny * w]);
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

// 外框一条边：仍是长波长波，但偶尔断开一小截（刻版漏墨）。
// 断口 3–7px，每条边 0–2 处，概率控制在“少许”，不会变成虚线
function fjOuterEdgePath(x1, y1, x2, y2, amp, rand) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 20) return fjWavePath(x1, y1, x2, y2, amp, 3, rand);
  const r = rand();
  const cuts = r < 0.16 ? 2 : (r < 0.6 ? 1 : 0);
  const pos = [];
  for (let i = 0; i < cuts; i++) pos.push(0.15 + rand() * 0.7);
  pos.sort((a, b) => a - b);
  const runs = [];
  let start = 0;
  pos.forEach((p) => {
    const at = p * len;
    const gap = 3 + rand() * 4;
    runs.push([start, Math.max(start, at)]);
    start = at + gap;
  });
  runs.push([start, len]);
  return runs
    .filter((seg) => seg[1] - seg[0] > 8)
    .map(([a, b]) => {
      const sx = x1 + (x2 - x1) * (a / len);
      const sy = y1 + (y2 - y1) * (a / len);
      const ex = x1 + (x2 - x1) * (b / len);
      const ey = y1 + (y2 - y1) * (b / len);
      const segs = Math.max(2, Math.round(((b - a) / len) * 4));
      return fjWavePath(sx, sy, ex, ey, amp, segs, rand);
    })
    .join('');
}

// 竖界行：长段连续、墨色深浅不匀，只在段间接缝处偶有一点极短的断口
// （刻版真实效果是“线基本连贯、个别地方淡掉”，所以不能切成等长短划，否则像虚线）
function fjRoughRule(x, yTop, yBottom, rand) {
  // 整条界行沿一条长波缓慢起伏（波长 140–300px、幅度 0.9–1.7px），
  // 段落内部再叠一点细微抖动，看起来是刻歪的长线而不是锯齿
  const wavAmp = 0.12 + rand() * 0.18;    // 长波幅度 0.12–0.3px：几乎笔直，只留一点手刻的不匀
  const period = 140 + rand() * 160;
  const phase = rand() * Math.PI * 2;
  const xAt = (yy) => x + Math.sin((yy / period) * Math.PI * 2 + phase) * wavAmp;
  const mkSeg = (a, b) => {
    let d = `M${xAt(a).toFixed(2)} ${a.toFixed(2)}`;
    let py = a;
    while (py < b) {
      py = Math.min(b, py + 4);
      d += `L${(xAt(py) + (rand() * 2 - 1) * 0.06).toFixed(2)} ${py.toFixed(2)}`;
    }
    return d;
  };

  let out = '';
  let y = yTop + rand() * 1.5;
  while (y < yBottom - 1) {
    let seg = 18 + rand() * 42;
    let end = Math.min(yBottom, y + seg);
    if (yBottom - end < 10) end = yBottom;            // 末尾不足一小段就直接补齐
    // 墨色以浓墨为主：约八成段落接近实黑，只有约一成略淡
    const op = rand() < 0.12 ? (0.42 + rand() * 0.16) : (0.78 + rand() * 0.17);
    out += `<path d="${mkSeg(y, end)}" fill="none" stroke="${FRAME_INK_THIN}" stroke-width="1" opacity="${op.toFixed(2)}" vector-effect="non-scaling-stroke"/>`;
    // 段间留白：以无缝为主；约一成留 3–8px 的小空口；约 3.5% 留一截 12–45px 的长空白
    const g = rand();
    if (g < 0.035) {
      y = end + 12 + rand() * 33;
    } else if (g < 0.135) {
      y = end + 3 + rand() * 5;
    } else if (g < 0.5) {
      y = end + rand() * 1.2;
    } else {
      y = end - 0.5;
    }
  }
  return out;
}

// 做旧版整块墨线：外框粗线微微弯、叠一层更抖的淡线模拟墨色浓淡；
// 内框细线轻抖；界行断续
function buildRoughFrameInk(frameWpx, frameHpx, ruleXs, seed) {
  const rand = fjRoughRand(seed);
  const inset = FRAME_INNER_INSET_PX;
  const x0 = 1, y0 = 1, x1 = frameWpx - 2, y1 = frameHpx - 2;
  const parts = [];
  // [x1, y1, x2, y2, 弯曲幅度, 是否可断]：上下横框接近平直且不断，只有左右竖框会断
  const outerEdges = [
    [x0, y0, x1, y0, 0.7, false], [x0, y1, x1, y1, 0.7, false],
    [x0, y0, x0, y1, 1.6, true], [x1, y0, x1, y1, 1.6, true]
  ];
  outerEdges.forEach((e) => {
    // 外框：只画一条实黑线（不叠淡灰线，否则会看到灰线和黑线错位重叠）；
    // 弯曲走长波长波，粗细按边随机 2.2–2.8px，做出木刻的厚薄不匀
    const w = (2.2 + rand() * 0.6).toFixed(2);
    const d = e[5] ? fjOuterEdgePath(e[0], e[1], e[2], e[3], e[4], rand) : fjWavePath(e[0], e[1], e[2], e[3], e[4], 4, rand);
    parts.push(`<path d="${d}" fill="none" stroke="${FRAME_INK}" stroke-width="${w}" opacity="0.95" vector-effect="non-scaling-stroke"/>`);
  });
  const i0 = inset, i1 = frameWpx - inset, j0 = inset, j1 = frameHpx - inset;
  const innerEdges = [[i0, j0, i1, j0], [i0, j1, i1, j1], [i0, j0, i0, j1], [i1, j0, i1, j1]];
  innerEdges.forEach((e) => {
    parts.push(`<path d="${fjRoughLine(e[0], e[1], e[2], e[3], 0.15, rand)}" fill="none" stroke="${FRAME_INK_THIN}" stroke-width="0.5" opacity="0.8" vector-effect="non-scaling-stroke"/>`);
  });
  ruleXs.forEach((x) => parts.push(fjRoughRule(x, j0 + 1, j1 - 1, rand)));
  return parts.join('');
}

// 用当前页的列位置生成版框：外框粗线 + 内侧细线，列与列之间画界行
// 注意：绝对定位是相对 .fj-page/.print-page 的 padding box（即整张纸），所以偏移要加上页边距
// 位置统一换算成整数 CSS px，避免 1px 细线落在半像素上发虚、看起来缺一条或粗细不一
function buildPageFrame(colsOfPage, innerHmm, marginMm, pageNo, pageWmm, colWmmOverride, slotCount) {
  if (!colsOfPage || !colsOfPage.length) return '';
  const showFrame = currentAntiqueFrame;
  if (!showFrame && !currentPageNumber) return '';
  const margin = Number(marginMm) || 0;
  const pm = pageNo ? pageMargins(pageNo) : { left: margin, right: margin };
  const padX = FRAME_PAD_X_MM;
  const padY = FRAME_PAD_Y_MM;
  const last = colsOfPage[colsOfPage.length - 1];
  const blockWpx = Math.round((last.rightMm + last.widthPx / PX_PER_MM) * PX_PER_MM);
  const pageWpx = Math.round((Number(pageWmm) || 0) * PX_PER_MM);
  // 传进来的 innerHmm 是“文字带”高度（已扣掉上下留白 padY）
  const innerHpx = Math.round(innerHmm * PX_PER_MM);
  const paperHpx = Math.round((innerHmm + padY * 2 + margin * 2) * PX_PER_MM);
  const marginPx = Math.round(margin * PX_PER_MM);
  const marginLPx = Math.round(pm.left * PX_PER_MM);
  const marginRPx = Math.round(pm.right * PX_PER_MM);
  const padXPx = Math.round(padX * PX_PER_MM);
  const padYPx = Math.round(padY * PX_PER_MM);
  // 竖排文字在列里天然靠右，界行位置再往右挪一点，让每列左右留白接近
  const ruleShiftPx = Math.round(0.9 * PX_PER_MM);
  const rightPx = marginRPx - padXPx;

  // 版框高度固定占满整条正文带（正文带 + 上下留白），不再随文字多少伸缩：
  // 每段都很短时框也保持满页高度，不会缩成一小截
  const bandHpx = innerHpx + padYPx * 2;      // 框占用的高度
  const frameHpx = bandHpx;
  const frameTopPx = marginPx;                // 框顶 = 上页边距

  // 「满页」模式：列宽由调用方按 (版心宽 − 列距) / 总列数 重新算过（总列数含空白列），
  // 版框横向满版心，界行按新的等宽列距画，不留窄列
  const overrideWmm = Number(colWmmOverride) || 0;
  const innerWpx = pageWpx - marginLPx - marginRPx;
  const gapPx = FRAME_GAP_MM * PX_PER_MM;
  const slotsOfFull = Math.max(1, Math.round(Number(slotCount) || colsOfPage.length));
  const fullMode = overrideWmm > 0 && colsOfPage.length > 0;
  let frameWpx = 0;
  let fullPitchPx = 0;
  let blankCols = 0;
  let pitchPx = 0;

  if (fullMode) {
    frameWpx = innerWpx + padXPx * 2 - ruleShiftPx;
    // 列距 = (版心宽 + 列间距) / 总列数：这样 slots 列正好充满版心，左边缘与框内线齐
    fullPitchPx = (innerWpx + gapPx) / slotsOfFull;
  } else {
    // 每列的列距（列宽 + 界行间距，px）：优先用本页相邻两列的实测右偏移差
    const colPitchPx = Math.round(last.widthPx + FRAME_GAP_MM * PX_PER_MM);
    pitchPx = colPitchPx;
    if (colsOfPage.length >= 2) {
      const prev = colsOfPage[colsOfPage.length - 2];
      const d = Math.round((prev.rightMm - last.rightMm) * PX_PER_MM);
      if (d > 4) pitchPx = d;
    }

    // 版框宽度 = 已用列 + 能整列放下的空白列；剩下不足一列宽的部分不画窄列，
    // 直接把版框左线收在那里（这部分留白落在框外，不会出现“最后一列太窄”）
    const blankAvailPx = Math.max(0, innerWpx - blockWpx);
    blankCols = (pitchPx > 4) ? Math.floor((blankAvailPx + 2) / pitchPx) : 0;
    frameWpx = blockWpx + blankCols * pitchPx + padXPx * 2 - ruleShiftPx;
  }

  // 界行位置（相对版框右缘的 px），两种模式各自算出后再统一画
  const ruleXs = [];
  if (showFrame) {
    const pushRule = (xpx) => {
      const xLeft = frameWpx - 2 - xpx;
      // 界行只在内线之内，不越出双线框内线
      if (xLeft > FRAME_INNER_INSET_PX + 0.5) ruleXs.push(xLeft);
    };
    if (fullMode) {
      // 按新的等宽列距逐条画：第 i 条界行在 (i 列距 − 半列距) 处；总列数含空白列
      for (let i = 1; i < slotsOfFull; i++) {
        pushRule(Math.round(padXPx + i * fullPitchPx - gapPx / 2 - ruleShiftPx));
      }
    } else {
      const xOfRule = (col) => Math.round((col.rightMm + col.widthPx / PX_PER_MM + FRAME_GAP_MM / 2 + padX) * PX_PER_MM) - ruleShiftPx;
      colsOfPage.slice(0, -1).forEach((col) => pushRule(xOfRule(col)));
      // 空白列按整列宽补齐：最左文字列左边界那条界行必须画，之后每隔一个列距一条，
      // 数量与版框宽度算出的 blankCols 一致，正好收到框内左线
      if (pitchPx > 4) {
        const lastX = xOfRule(last);
        for (let k = 0; k < blankCols; k++) pushRule(lastX + pitchPx * k);
      }
    }
  }

  const mkRule = (xLeft) =>
    `<line x1="${xLeft}" y1="${FRAME_INNER_INSET_PX}" x2="${xLeft}" y2="${frameHpx - FRAME_INNER_INSET_PX}" stroke="${FRAME_INK_THIN}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;

  // 版框用 SVG：双线 + 界行都是矢量，任何 DPI 下都不会发虚；
  // vector-effect 保证 syncFrameGeometry 改高度时线宽仍是 2px / 0.5px，不会被拉粗拉细
  // 「做旧」时改用带确定性抖动的 path（外粗线微微弯、内细线与界行断续），打印仍是矢量
  const roughSeed = (Number(pageNo) || 1) * 1013 + Math.round(frameHpx);
  const frameInk = currentFrameRough
    ? buildRoughFrameInk(frameWpx, frameHpx, ruleXs, roughSeed)
    : `<rect x="1" y="1" width="${frameWpx - 2}" height="${frameHpx - 2}" fill="none" stroke="${FRAME_INK}" stroke-width="2" vector-effect="non-scaling-stroke"/><rect x="${FRAME_INNER_INSET_PX}" y="${FRAME_INNER_INSET_PX}" width="${frameWpx - FRAME_INNER_INSET_PX * 2}" height="${frameHpx - FRAME_INNER_INSET_PX * 2}" fill="none" stroke="${FRAME_INK_THIN}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>${ruleXs.map(mkRule).join('')}`;
  const frameHtml = showFrame
    ? `<svg class="fj-frame" xmlns="http://www.w3.org/2000/svg" width="${frameWpx}" height="${frameHpx}" viewBox="0 0 ${frameWpx} ${frameHpx}" preserveAspectRatio="none" style="position:absolute;right:${rightPx}px;top:${frameTopPx}px;width:${frameWpx}px;height:${frameHpx}px;overflow:visible;pointer-events:none;">${frameInk}</svg>`
    : '';

  // 页码：整体居中放在页码所在一侧的页边距里（左页取左页边距、右页取右页边距）
  // 盒子等于整条页边距宽度，页码由此不会压到正文，也不会跨到版框线上
  // 作为 .fj-page 的直接子元素，避免被版框自身的盒子裁掉
  const noHpx = Math.round(3.6 * PX_PER_MM);
  const frameBottomGapPx = paperHpx - (frameTopPx + frameHpx);   // 框底到纸边的距离
  const noBottomPx = Math.max(2, frameBottomGapPx);
  // 页码：居中放在页码所在一侧的页边距里，且整字落在版框外线之外
  // 纸张 → 页码 → 版框外线 → 正文，永不相互压叠
  const noOnRight = pageNoSide(pageNo) === 'right';
  const noBandRPx = Math.max(noHpx + 2, marginRPx - padXPx);
  const noBandLPx = Math.max(noHpx + 2, marginLPx - padXPx);
  const noPosStyle = noOnRight
    ? `right:0;width:${noBandRPx}px;text-align:center;`
    : `left:0;width:${noBandLPx}px;text-align:center;`;
  const pageNoHtml = (currentPageNumber && pageNo)
    ? `<span class="fj-pageno" style="position:absolute;box-sizing:border-box;bottom:${noBottomPx}px;${noPosStyle}font-size:${noHpx}px;line-height:1;color:${FRAME_INK};font-family:'${typeof currentFontFamily !== 'undefined' ? currentFontFamily : '方正金陵'}','KaiTi','宋体',serif;letter-spacing:0.5px;white-space:nowrap;">${toChineseNumeral(pageNo)}</span>`
    : '';

  return frameHtml + pageNoHtml;
}

// ========== 统一分页模型：预览与打印共用同一套算法 ==========
// 输入一组的竖排列元素（.vertical-paragraph），输出每页的列（含列宽、右偏移、HTML）
function buildPageModel(columnEls, opts) {
  const o = opts || {};
  const paperSize = o.paperSize || 'A5';
  const orientation = o.orientation || 'portrait';
  const paperMm = PAPER_MM[paperSize] || PAPER_MM.A5;
  let pageWmm = paperMm.w;
  let pageHmm = paperMm.h;
  if (orientation === 'landscape') {
    pageWmm = paperMm.h;
    pageHmm = paperMm.w;
  }
  const MARGIN_MM = Number(o.marginMm) || currentMarginMm;
  const GAP_MM = 2.6;
  const innerWmm = pageWmm - MARGIN_MM * 2 - gutterTotalWmm();
  const innerHmm = pageHmm - MARGIN_MM * 2;
  const usableHpx = getColumnHeightPx(paperSize, orientation);

  const cols = [];
  Array.from(columnEls).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const cs = getComputedStyle(el);
    const text = el.textContent || '';
    const base = {
      widthPx: rect.width,
      naturalWidthPx: rect.width,   // 版面设定的列宽（未被“铺满版心”拉伸过）
      heightPx: rect.height,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color
    };
    if (rect.height > usableHpx + 3 && text.length > 1 && !el.querySelector('*')) {
      // 列比一页可用高度还高时按高度切列，避免跨页断字
      const maxChars = Math.max(1, Math.floor((text.length * usableHpx) / rect.height));
      for (const chunk of sliceColumnText(text, maxChars)) {
        cols.push({
          ...base,
          heightPx: rect.height * (chunk.length / text.length),
          html: escapeHtml(chunk)
        });
      }
    } else {
      cols.push({ ...base, html: el.innerHTML });
    }
  });

  const pages = [];
  let pageCols = [];
  let usedWmm = 0;
  cols.forEach((col) => {
    const widthMm = col.widthPx / PX_PER_MM;
    if (pageCols.length && usedWmm + widthMm > innerWmm) {
      pages.push(pageCols);
      pageCols = [];
      usedWmm = 0;
    }
    col.rightMm = usedWmm;
    pageCols.push(col);
    usedWmm += widthMm + GAP_MM;
  });
  if (pageCols.length) pages.push(pageCols);
  // 除最后一页外，每页列宽铺满版心
  pages.forEach((p, i) => {
    if (i < pages.length - 1) fillPageWidth(p, innerWmm, GAP_MM);
  });

  return {
    pages,
    cols,
    pageWmm,
    pageHmm,
    MARGIN_MM,
    innerHmm,
    innerWmm,
    gapMm: GAP_MM,
    paperSize,
    orientation
  };
}

// 探测本机可用字体（用 canvas 度量：与回退字体宽度不同即认为已安装）
const FONT_CANDIDATES = [
  '方正金陵', '微软雅黑', '微软雅黑 Light', '宋体', '新宋体', '黑体', '楷体', '仿宋', '等线', '幼圆', '隶书',
  '华文中宋', '华文宋体', '华文楷体', '华文细黑', '华文行楷', '华文新魏', '华文琥珀', '华文彩云', '华文仿宋',
  '方正舒体', '方正姚体', '方正楷体', '方正书宋', '方正兰亭黑', '方正黑体', '方正仿宋', '方正小标宋', '方正清刻本悦宋',
  '思源宋体', '思源黑体', '汉仪书宋', '汉仪旗黑', '汉仪楷体', '冬青黑体', '苹方', 'PingFang SC', 'Songti SC', 'Kaiti SC',
  'Heiti SC', 'STSong', 'STKaiti', 'STHeiti', 'Hiragino Sans GB', 'Source Han Serif SC', 'Source Han Sans SC',
  'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'NSimSun', 'Microsoft YaHei', 'Microsoft YaHei UI', 'DengXian', 'YouYuan',
  'Arial', 'Times New Roman', 'Georgia', 'Garamond', 'Calibri', 'Cambria', 'Segoe UI', 'Tahoma', 'Verdana', 'Helvetica',
  'Helvetica Neue', 'Trebuchet MS', 'Palatino', 'Book Antiqua', 'Century Gothic', 'Copperplate', 'Futura', 'Gill Sans',
  'Courier New', 'Consolas', 'Menlo', 'Monaco', 'Baskerville', 'Didot', 'Optima', 'Rockwell', 'Impact'
];

// 请求主世界读取本机字体（首次聚焦字体框时触发，可能弹出授权）
let localFontsRequested = false;
let fontMessageBound = false;

function injectFontProbeScript() {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('fontlist.js');
    s.onload = () => s.remove();
    s.onerror = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.warn('[fonts] 注入字体探测脚本失败', e);
  }
}

// 展示优先级：第一梯队为 Windows / macOS 系统自带中文字体，第二梯队为常见字体厂商
const TIER1_FONTS = [
  '方正金陵', 'FZJinL-B_GBJF',
  '微软雅黑', 'Microsoft YaHei', '微软雅黑 Light', 'Microsoft YaHei Light',
  '宋体', 'SimSun', '新宋体', 'NSimSun', '黑体', 'SimHei', '楷体', 'KaiTi',
  '仿宋', 'FangSong', '等线', 'DengXian', '幼圆', 'YouYuan', '隶书', 'LiSu',
  'PingFang SC', 'PingFang TC', 'PingFang HK', '苹方', '苹方-简', '苹方-繁',
  'Songti SC', 'Songti TC', 'Kaiti SC', 'Kaiti TC', 'Heiti SC', 'Heiti TC',
  'STSong', 'STKaiti', 'STHeiti', 'Hiragino Sans GB', '冬青黑体', '华文细黑'
];

// 常见字体厂商前缀（匹配 family / fullName 开头）
const FOUNDRY_PREFIXES = [
  '方正', 'FZ', '华康', 'DF', '华文', 'ST', '汉仪', 'HY', '思源', 'Source Han',
  '站酷', 'ZCOOL', '造字工房', '字魂', '锐字', '腾祥', '仓耳', '优设',
  '阿里巴巴', 'Alibaba', 'HarmonyOS', 'MiSans', '鸿蒙', '寒蝉', '演示悠然',
  '汉仪字库', '锐字工房', '三极', '字由', '默陌', '梅花'
];

// Windows 自带的西文字体：字帖场景用不上，排到最后显示
const WINDOWS_EN_FONTS = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math',
  'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
  'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text',
  'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Marlett', 'Microsoft Sans Serif',
  'Mongolian Baiti', 'MS Gothic', 'MS Mincho', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Sitka', 'Sylfaen',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings',
  'Yu Gothic', 'Book Antiqua', 'Bookman Old Style', 'Century Gothic'
];

// 随 Microsoft Office 一起安装的西文字体（Windows 本身没有，办公装机才有）
const OFFICE_EN_FONTS = [
  'Agency FB', 'Algerian', 'Arial Rounded MT Bold', 'Baskerville Old Face', 'Bauhaus 93',
  'Bell MT', 'Berlin Sans FB', 'Bernard MT Condensed', 'Blackadder ITC', 'Bodoni MT',
  'Britannic Bold', 'Broadway', 'Brush Script MT', 'Californian FB', 'Calisto MT',
  'Castellar', 'Centaur', 'Century', 'Century Schoolbook', 'Colonna MT', 'Cooper Black',
  'Copperplate Gothic Bold', 'Copperplate Gothic Light', 'Curlz MT', 'Elephant',
  'Engravers MT', 'Eras Bold ITC', 'Eras Light ITC', 'Felix Titling', 'Footlight MT Light',
  'Forte', 'Franklin Gothic Book', 'Franklin Gothic Demi', 'Franklin Gothic Heavy',
  'Freestyle Script', 'French Script MT', 'Gigi', 'Gill Sans MT', 'Gill Sans Ultra Bold',
  'Gloucester MT Extra Condensed', 'Goudy Old Style', 'Goudy Stout', 'Haettenschweiler',
  'Harlow Solid Italic', 'Harvest', 'High Tower Text', 'Imprint MT Shadow', 'Informal Roman',
  'Jokerman', 'Juice ITC', 'Kristen ITC', 'Kunstler Script', 'Lucida Bright', 'Lucida Calligraphy',
  'Lucida Fax', 'Lucida Handwriting', 'Lucida Sans', 'Lucida Sans Typewriter', 'Magneto',
  'Maiandra GD', 'Matura MT Script Capitals', 'Modern No. 20', 'Monotype Corsiva', 'MT Extra',
  'Niagara Engraved', 'Niagara Solid', 'OCR A', 'OCR B', 'Old English Text MT', 'Onyx',
  'Palace Script MT', 'Papyrus', 'Parchment', 'Perpetua', 'Playbill', 'Poor Richard',
  'Pristina', 'Rage Italic', 'Ravie', 'Rockwell', 'Rockwell Extra Bold', 'Script MT Bold',
  'Showcard Gothic', 'Snap ITC', 'Stencil', 'Tempus Sans ITC', 'Viner Hand ITC', 'Vivaldi',
  'Vladimir Script', 'Wide Latin', 'Wingdings 2', 'Wingdings 3'
];

// macOS 自带与设计软件（Adobe / Corel 等）常见的西文字体：同样归入“英文字体”
// 只收常见一批，避免名单过宽把用户自己想用的字也藏起来
const DESIGN_EN_FONTS = [
  'Didot', 'Baskerville', 'Futura', 'Helvetica', 'Helvetica Neue', 'Optima', 'Hoefler Text',
  'Gill Sans', 'Avenir', 'Avenir Next', 'Athelas', 'Charter', 'Cochin', 'Seravek',
  'Superclarendon', 'Iowan Old Style', 'Marion', 'American Typewriter', 'Apple Chancery',
  'Bodoni 72', 'Chalkboard', 'Chalkduster', 'Trattatello', 'Snell Roundhand', 'Phosphate',
  'Herculanum', 'Krungthep', 'Lucida Grande', 'Marker Felt', 'Menlo', 'Monaco', 'Skia',
  'Zapf Dingbats', 'Zapfino', 'DIN', 'Adobe Garamond', 'Garamond', 'Garamond Premier',
  'Minion', 'Myriad', 'Trajan', 'Bembo', 'Caslon', 'Adobe Caslon', 'Utopia', 'Frutiger',
  'Univers', 'Futura PT', 'Neue Haas Grotesk', 'Proxima Nova', 'Gotham', 'Brandon Grotesque',
  'Avenir LT', 'Source Sans', 'Open Sans', 'Roboto', 'Lato', 'Montserrat', 'Poppins'
];

// 系统自带 + Office + macOS/设计软件带来的西文字体，统一视为“英文字体”
const LATIN_BUNDLED_FONTS = WINDOWS_EN_FONTS.concat(OFFICE_EN_FONTS, DESIGN_EN_FONTS);

// 名称是否落在这个西文名单里：
// 1) 完全相等；2) 字体名以名单名开头（Arial Bold → Arial）；
// 3) 名单名以字体名开头且后面是分隔符（"Bernard MT" ↔ "Bernard MT Condensed"），
//    这样系统里只报出缩写家族名的情况也能识别
function matchLatinListed(name, list) {
  const lower = String(name || '').toLowerCase().trim();
  if (!lower) return false;
  return list.some((en) => {
    const e = en.toLowerCase();
    if (lower === e || lower.startsWith(e)) return true;
    if (!e.startsWith(lower)) return false;
    const next = e.charAt(lower.length);
    return next === '' || next === ' ' || next === '-' || next === '_' || next === '.';
  });
}

// cmap 汉字检测结果（「全部字体」页解析后写入 fontCmapCache）：postscriptName -> { n, cjk }
// 判为“英文字体”的门槛：常用 3500 字里命中少于这个数
const CJK_MIN_HITS = 100;
let cmapByPs = {};
let cmapByFamily = new Map(); // family(小写) -> 该家族里命中最多那个 face 的命中数

function setCmapCache(map) {
  cmapByPs = (map && typeof map === 'object') ? map : {};
  rebuildCmapIndex();
}

function rebuildCmapIndex() {
  const idx = new Map();
  (fontFaces || []).forEach(f => {
    const rec = cmapByPs[f.postscriptName];
    if (!rec || typeof rec.n !== 'number') return;
    const fam = String(f.family || '').toLowerCase().trim();
    if (!fam) return;
    const prev = idx.get(fam);
    if (prev == null || rec.n > prev) idx.set(fam, rec.n);
  });
  cmapByFamily = idx;
}

function loadCmapCache() {
  try {
    chrome.storage.local.get(['fontCmapCache'], (r) => {
      if (r && r.fontCmapCache && r.fontCmapCache.map) {
        setCmapCache(r.fontCmapCache.map);
        // 分类结果变了：重排下拉顺序并让它重绘
        fontOptions = sortFontOptions(fontOptions);
        document.dispatchEvent(new Event('fj-fonts-updated'));
      }
    });
  } catch (e) {}
}

// 返回该家族命中的常用字数；没检测过返回 null（调用方回退到名单判断）
function cmapChineseHits(name) {
  const lower = String(name || '').toLowerCase().trim();
  if (!lower) return null;
  if (cmapByFamily.has(lower)) return cmapByFamily.get(lower);
  let best = null;
  cmapByFamily.forEach((n, fam) => {
    if (lower.startsWith(fam) || fam.startsWith(lower)) {
      if (best == null || n > best) best = n;
    }
  });
  return best;
}

function isWindowsEnFont(name) {
  const hits = cmapChineseHits(name);
  if (hits != null) return hits < CJK_MIN_HITS;
  return matchLatinListed(name, LATIN_BUNDLED_FONTS);
}

function sortFontOptions(list) {
  const tier1Order = new Map();
  TIER1_FONTS.forEach((name, i) => tier1Order.set(name.toLowerCase(), i));
  const winEnOrder = new Map();
  LATIN_BUNDLED_FONTS.forEach((name, i) => winEnOrder.set(name.toLowerCase(), i));

  const rank = (name) => {
    const lower = name.toLowerCase();
    if (tier1Order.has(lower)) return { tier: 1, order: tier1Order.get(lower) };
    for (const [t1, order] of tier1Order) {
      if (lower.startsWith(t1)) return { tier: 1, order };
    }
    // 检测过的字体以 cmap 结果为准：命中不到 100 字 → 归入英文字体（排在名单之后）
    const cnHits = cmapChineseHits(name);
    if (cnHits != null) {
      if (cnHits < CJK_MIN_HITS) return { tier: 4, order: 1000 };
    } else {
      if (winEnOrder.has(lower)) return { tier: 4, order: winEnOrder.get(lower) };
      for (const [en, order] of winEnOrder) {
        if (lower.startsWith(en)) return { tier: 4, order };
        if (en.startsWith(lower)) {
          const next = en.charAt(lower.length);
          if (next === '' || next === ' ' || next === '-' || next === '_' || next === '.') return { tier: 4, order };
        }
      }
    }
    if (FOUNDRY_PREFIXES.some(p => lower.startsWith(p.toLowerCase()) || name.startsWith(p))) {
      return { tier: 2, order: 0 };
    }
    return { tier: 3, order: 0 };
  };

  return list.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    if (ra.order !== rb.order) return ra.order - rb.order;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
}

let fullFontListLoaded = false;   // 本机全部字体是否已读到（含磁盘缓存）
let fontRefreshDone = false;      // 本次会话是否已向浏览器实读一次
let fontFetchInFlight = false;
let fontFetchAt = 0;
let fontReplacePending = false;   // 手动“重新读取”时置位：拿到新名单后整表替换（不是追加）
// 字体原始元数据（family / fullName / postscriptName / style），供“全部字体”页展示
let fontFaces = [];

function registerFontFaces(list) {
  if (!Array.isArray(list) || !list.length) return;
  const seen = new Set(fontFaces.map(f => [f.family, f.fullName, f.postscriptName, f.style].join('\u0001')));
  list.forEach(f => {
    if (!f) return;
    const row = {
      family: String(f.family || '').trim(),
      fullName: String(f.fullName || '').trim(),
      postscriptName: String(f.postscriptName || '').trim(),
      style: String(f.style || '').trim()
    };
    if (!row.family && !row.fullName) return;
    const key = [row.family, row.fullName, row.postscriptName, row.style].join('\u0001');
    if (seen.has(key)) return;
    seen.add(key);
    fontFaces.push(row);
  });
  rebuildCmapIndex();
}

// 字体别名：family → 其它可搜的名字（fullName 等）。中文家族名 + 英文全名时，搜英文也能命中
let fontAliases = {};

// fullName 里常带中文名（如「方正博雅宋简体 常规」），去掉尾部字重/样式词后可直接当显示名
const FONT_STYLE_SUFFIX_RE = /[\s·\-_]*(常规体|常规|标准体|标准|粗体|细体|特粗|中粗|幼线|中等|粗|细|Regular|Normal|Book|Roman|Light|Medium|SemiBold|Semibold|DemiBold|Bold|ExtraBold|UltraBold|Heavy|Black|Thin|ExtraLight|UltraLight|Oblique|Italic|Condensed|Narrow|Wide)\s*$/i;

function stripFontStyle(name) {
  let s = String(name || '').trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(FONT_STYLE_SUFFIX_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

// 给一个 family 找中文显示名：优先 family 本身含中文，其次 fullName 类别名里含中文的
function fontDisplayName(name) {
  const self = String(name || '').trim();
  if (!self) return self;
  const hasCJK = (v) => /[\u3400-\u9fff]/.test(v);
  const alts = (fontAliases[self] || []).map(stripFontStyle).filter(v => v && hasCJK(v));
  if (hasCJK(self)) {
    // family 本身是中文时，若别名里有更完整的中文名（更长且不是纯字重差异）仍用别名
    const longer = alts.filter(v => v.length > self.length && v.startsWith(self));
    return longer.length ? longer[0] : self;
  }
  if (!alts.length) return self;
  // 多个字重时取最短的中文名，避免出现「… 粗体」「… 细体」各一条
  return alts.sort((a, b) => a.length - b.length)[0];
}

function registerFontAliases(map) {
  if (!map || typeof map !== 'object') return;
  let changed = false;
  Object.keys(map).forEach((key) => {
    const extra = Array.isArray(map[key]) ? map[key] : [map[key]];
    const list = fontAliases[key] || (fontAliases[key] = []);
    extra.forEach((n) => {
      const v = String(n || '').trim();
      if (v && !list.includes(v)) { list.push(v); changed = true; }
    });
  });
  // 别名晚于字体名到达（缓存先命中）时，下拉里的中文显示名要跟着重绘
  if (changed) setTimeout(() => document.dispatchEvent(new Event('fj-fonts-updated')), 0);
}

// 字体列表缓存：上次读到的全量字体直接可用，省去每次搜索都去读一遍
const FONT_CACHE_KEY = 'fontCache';
const FONT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;   // 7 天

function saveFontCache() {
  try {
    chrome.storage.local.set({ [FONT_CACHE_KEY]: { fonts: fontOptions.slice(), aliases: fontAliases, faces: fontFaces, at: Date.now() } });
  } catch (e) {}
}

function loadFontCache() {
  try {
    chrome.storage.local.get([FONT_CACHE_KEY], (r) => {
      const c = r && r[FONT_CACHE_KEY];
      if (!c || !Array.isArray(c.fonts) || !c.fonts.length) return;
      if (Date.now() - Number(c.at || 0) > FONT_CACHE_TTL) return;   // 太旧就重新读
      // 别名（含中文 fullName）一起恢复，否则缓存命中时下拉只能显示英文 family
      if (c.aliases && typeof c.aliases === 'object') registerFontAliases(c.aliases);
      if (Array.isArray(c.faces)) registerFontFaces(c.faces);
      const merged = c.fonts.filter(n => !fontOptions.includes(n));
      if (merged.length) fontOptions = sortFontOptions(fontOptions.concat(merged));
      fullFontListLoaded = true;
      document.dispatchEvent(new Event('fj-fonts-updated'));
    });
  } catch (e) {}
}

function mergeFonts(list, replace) {
  if (!Array.isArray(list) || !list.length) return false;
  let added = false;
  if (replace) {
    // 手动重新读取：整表替换成这次拿到的系统字体（保留内置候选兜底）
    const fresh = new Set();
    list.forEach(n => { const v = String(n || '').trim(); if (v) fresh.add(v); });
    FONT_CANDIDATES.forEach(n => { if (!fresh.has(n)) fresh.add(n); });
    fontOptions = sortFontOptions(Array.from(fresh));
    added = true;
  } else {
    list.forEach(name => {
      if (name && !fontOptions.includes(name)) { fontOptions.push(name); added = true; }
    });
    if (added) fontOptions = sortFontOptions(fontOptions);
  }
  const firstLoad = !fullFontListLoaded;
  fullFontListLoaded = true;
  fontRefreshDone = true;
  saveFontCache();
  // 首读完成时也要通知（下拉正开着搜索，需要用全量字体重算匹配）
  if (added || firstLoad) document.dispatchEvent(new Event('fj-fonts-updated'));
  return added;
}

// 手动“重新读取系统字体”：先试主世界 API，再试后台，最后用主世界探针脚本；
// 拿到名单后整表替换，这样新装的字体出现、卸掉的字体消失
function refreshFontList(onDone) {
  fontReplacePending = true;
  const finish = (list, source) => {
    if (!list || !list.length) return false;
    fontReplacePending = false;
    mergeFonts(list, true);
    if (onDone) onDone(fontOptions.length, source);
    return true;
  };
  const fallback = () => {
    injectFontProbeScript();
    if (onDone) onDone(-1, 'probe');
  };
  queryLocalFontsDirect().then(list => {
    if (finish(list, 'api')) return;
    try {
      chrome.runtime.sendMessage({ action: 'GET_LOCAL_FONTS' }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.success) {
          registerFontAliases(resp.aliases);
          registerFontFaces(resp.faces);
        }
        if (!chrome.runtime.lastError && resp && resp.success && resp.fonts && finish(resp.fonts, 'bg')) return;
        fallback();
      });
    } catch (e) {
      fallback();
    }
  });
}

// 在 content script 里直接调用（依赖用户手势，浏览器才会弹授权框）
function queryLocalFontsDirect() {
  if (typeof window.queryLocalFonts !== 'function') return Promise.resolve(null);
  try {
    return window.queryLocalFonts().then(faces => {
      // 以 family 为准：同一家族的多字重只留一条
      const set = new Set();
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
      registerFontAliases(aliases);
      registerFontFaces((faces || []).map(f => ({
        family: f && f.family,
        fullName: f && f.fullName,
        postscriptName: f && f.postscriptName,
        style: f && f.style
      })));
      return Array.from(set);
    }).catch(err => {
      console.warn('[fonts] 直接读取失败:', err && err.name, err && err.message);
      return null;
    });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function requestLocalFonts(force) {
  // 本次会话已经实读过就不再读；命中磁盘缓存时也只需后台刷新一次
  if (fontRefreshDone) return;
  if (fontFetchInFlight) return;
  const now = Date.now();
  if (!force && localFontsRequested && now - fontFetchAt < 5000) return;
  localFontsRequested = true;
  fontFetchAt = now;
  fontFetchInFlight = true;
  const finish = () => { fontFetchInFlight = false; };
  queryLocalFontsDirect().then(fonts => {
    if (fonts && fonts.length && mergeFonts(fonts)) return finish();
    finish();
    try {
      chrome.runtime.sendMessage({ action: 'GET_LOCAL_FONTS' }, (resp) => {
        if (chrome.runtime.lastError) {
          injectFontProbeScript();
          return;
        }
        if (resp && resp.success) {
          registerFontAliases(resp.aliases);
          registerFontFaces(resp.faces);
        }
        if (resp && resp.success && mergeFonts(resp.fonts)) return;
        injectFontProbeScript();
      });
    } catch (e) {
      injectFontProbeScript();
    }
  }).catch(() => finish());
}

let fontOptions = [];
let recentFonts = [];   // 最近使用过的字体（下拉里排最前）
let favoriteFonts = []; // 收藏的字体（排在最前）
let fontPanelScale = 1; // 字体下拉被拉大时，里面文字同步放大
let showWindowsEnFonts = false; // “英文字体”：默认不显示 Windows 自带西文字体

// 启动时先吃磁盘缓存：上次读到的全量字体立刻可用于搜索
try { loadFontCache(); } catch (e) {}
// cmap 汉字检测结果（全部字体页解析后会更新），用于判定“英文字体”
try { loadCmapCache(); } catch (e) {}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.fontCmapCache) return;
    const next = changes.fontCmapCache.newValue;
    if (!next || !next.map || typeof next.map !== 'object') return;
    setCmapCache(next.map);
    fontOptions = sortFontOptions(fontOptions);
    document.dispatchEvent(new Event('fj-fonts-updated'));
  });
} catch (e) {}

// 字体下拉里的示例句（取自《千字文》）
const QIANZIWEN_LINES = [
  '天地玄黄，宇宙洪荒', '日月盈昃，辰宿列张', '寒来暑往，秋收冬藏', '闰余成岁，律吕调阳',
  '云腾致雨，露结为霜', '金生丽水，玉出昆冈', '剑号巨阙，珠称夜光', '果珍李柰，菜重芥姜',
  '海咸河淡，鳞潜羽翔', '龙师火帝，鸟官人皇', '始制文字，乃服衣裳', '推位让国，有虞陶唐',
  '知过必改，得能莫忘', '罔谈彼短，靡恃己长', '信使可覆，器欲难量', '墨悲丝染，诗赞羔羊',
  '景行维贤，克念作圣', '德建名立，形端表正', '空谷传声，虚堂习听', '尺璧非宝，寸阴是竞'
];
let fontSampleLine = QIANZIWEN_LINES[Math.floor(Math.random() * QIANZIWEN_LINES.length)];

function rememberFont(name) {
  const v = String(name || '').trim();
  if (!v) return;
  recentFonts = [v].concat(recentFonts.filter(n => n !== v)).slice(0, 8);
  try { chrome.storage.local.set({ recentFonts }); } catch (e) {}
}

function bindLocalFontMessages() {
  if (fontMessageBound) return;
  fontMessageBound = true;
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'FJ_LOCAL_FONTS') return;
    registerFontAliases(e.data.aliases);
    registerFontFaces(e.data.faces);
    mergeFonts(e.data.fonts, fontReplacePending);
    fontReplacePending = false;
  });
}

function detectLocalFonts() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const sample = '汉字AaBbGg0123';
  const found = [];
  FONT_CANDIDATES.forEach(name => {
    ctx.font = '16px monospace';
    const base = ctx.measureText(sample).width;
    ctx.font = `16px "${name}", monospace`;
    const w = ctx.measureText(sample).width;
    if (Math.abs(w - base) > 0.5) found.push(name);
  });
  return found;
}

// 一列可用高度（像素）：纸张高度减去上下页边距
function getColumnHeightPx(paperSize = 'A5', orientation = 'portrait') {
  const size = PAPER_MM[paperSize] || PAPER_MM.A5;
  const pageHmm = orientation === 'landscape' ? size.w : size.h;
  // 开了版框时，上下各留出版框留白，保证框内文字上下有白、框本身不越出版心
  const framePadMm = (typeof currentAntiqueFrame !== 'undefined' && currentAntiqueFrame) ? FRAME_PAD_Y_MM * 2 : 0;
  return (pageHmm - currentMarginMm * 2 - framePadMm) * PX_PER_MM;
}

// 根据纸张可用高度动态计算每列字数（随字号、行距变化）
function getMaxCharsPerColumn(paperSize = 'A5', lineHeight = 1.5, orientation = 'portrait') {
  const innerHpx = getColumnHeightPx(paperSize, orientation);
  const fs = (typeof currentFontSize !== 'undefined' ? currentFontSize : 14) + 'pt';
  // 用真实字体逐字二分实测“不换行时一列最多放几个字”，避免估算偏差导致末字折行
  const measured = measureMaxCharsPerColumn(innerHpx, fs, lineHeight);
  if (measured > 1) return measured;
  const advance = measureCharAdvance(fs, lineHeight);
  return Math.max(1, Math.floor((innerHpx - 1) / advance) - 1);
}

// 实测一列能放多少字：竖排 + nowrap，二分逼近最大不折行字数
function measureMaxCharsPerColumn(innerHpx, fontSize = '14pt', lineHeight = 1.5) {
  const fam = `'${typeof currentFontFamily !== 'undefined' ? currentFontFamily : '方正金陵'}','FZJinL-B_GBJF','华文楷书','KaiTi','宋体',serif`;
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:-9999px;top:0;writing-mode:vertical-rl;text-orientation:upright;white-space:nowrap;font-size:${fontSize};line-height:${lineHeight};letter-spacing:${typeof currentLetterSpacing !== 'undefined' ? currentLetterSpacing : 0}px;font-family:${fam};margin:0;padding:0;border:0;`;
  document.body.appendChild(probe);
  let lo = 1, hi = 240, best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    probe.textContent = '国'.repeat(mid);
    const h = probe.getBoundingClientRect().height;
    if (h > 0 && h <= innerHpx - 0.5) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  probe.remove();
  return best;
}

function getMaxColumnsPerPage(paperSize) {
  // 返回每页最大列数（A5约17，A4约34）
  return paperSize === 'A5' ? 18 : 36;
}

function showA5FloatingPanel(text, selectedTitle = '', selectedSubtitle = '') {
  // 每次打开面板都从本次抓取的正文开始，清掉上一次页面的编辑/自动排版结果
  window.editedText = null;

  // 纸张大小变量
  let currentPaperSize = 'A5'; // 默认 A5
  let maxCharsPerColumn = 37; // A5 默认每列 37 字

  const existingPanel = document.getElementById('fj-a5-panel');
  if (existingPanel) existingPanel.remove();
  
  let defaultTitle = selectedTitle;
  if (!defaultTitle) defaultTitle = '方正金陵 · 雅集';
  if (defaultTitle.length > 50) defaultTitle = defaultTitle.substring(0, 50) + '...';
  
  let currentSubtitle = selectedSubtitle;
  let currentTitle = defaultTitle;
  let windowEditedText = null;
  
  const subtitleInput = document.createElement('input');
  subtitleInput.id = 'fj-subtitle-input';
  subtitleInput.type = 'text';
  subtitleInput.value = currentSubtitle;
  subtitleInput.placeholder = '朝代、作者（可选）';
  
  const overlay = document.createElement('div');
  overlay.id = 'fj-a5-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 999999;
    display: flex;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(3px);
    font-family: system-ui, sans-serif;
  `;
  
  const panel = document.createElement('div');
  panel.id = 'fj-a5-panel';
  panel.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: stretch;
    width: auto;
    height: auto;
    max-width: 94vw;
    background: #eef2f7;
    border-radius: 8px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    font-family: '方正金陵', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif;
    font-weight: normal;
    line-height: 1.8;
    color: #1e293b;
    max-height: 92vh;
    overflow: hidden;
    position: relative;
    animation: fjSlideUp 0.25s ease-out;
  `;
  
  if (!document.getElementById('fj-anim-style')) {
    const styleAnim = document.createElement('style');
    styleAnim.id = 'fj-anim-style';
    styleAnim.textContent = `
      @keyframes fjSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #fj-a5-panel::-webkit-scrollbar { width: 6px; }
      #fj-a5-panel::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 8px; }
      #fj-a5-panel::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
      /* 右栏滚动条做窄，避免占掉字段宽度让右栏显得窄 */
      .fj-sidebar::-webkit-scrollbar { width: 6px; }
      .fj-sidebar::-webkit-scrollbar-track { background: transparent; }
      .fj-sidebar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
      .fj-sidebar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      #fj-a5-panel::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

      /* 右栏较窄，字段名不拆行 */
      .fj-epigraph-toolbar > span,
      .fj-layout-toolbar > span,
      .fj-epigraph-toolbar > label,
      .fj-layout-toolbar > label { white-space: nowrap; flex-shrink: 0; }

      /* 底部按钮栏文字不换行 */
      .fj-footer span,
      .fj-footer label,
      .fj-footer button { white-space: nowrap; flex-shrink: 0; }

      /* 右栏统一小节样式 */
      .fj-side-section {
        padding: 12px 16px;
        border-bottom: 1px solid #eef2f7;
        background: #fff;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        color: #334155;
      }
      .fj-side-label { font-size: 12px; color: #475569; white-space: nowrap; flex-shrink: 0; }
      .fj-side-section button {
        height: 26px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #334155;
        font-size: 12px;
        cursor: pointer;
      }
      .fj-side-section button:hover { background: #eef2f7; }
      .fj-side-section .fj-btn-primary { background: #2c3e66; border-color: #2c3e66; color: #fff; }
      .fj-side-section input[type="number"],
      .fj-side-section select {
        height: 26px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #334155;
        font-size: 12px;
        padding: 0 6px;
      }

      /* 右栏卡片分组 */
      .fj-card {
        box-sizing: border-box;
        flex: 0 0 auto;
        width: 100%;
        min-width: 0;
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 10px 12px;
        box-shadow: 0 2px 6px rgba(15, 23, 42, 0.07);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        color: #334155;
      }
      .fj-card-title {
        flex: 0 0 100%;
        font-size: 12px;
        font-weight: 600;
        color: #1e293b;
      }
      .fj-card button {
        height: 26px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #334155;
        font-size: 12px;
        cursor: pointer;
      }
      .fj-card button:hover { background: #eef2f7; color: #0f172a; }
      .fj-card .fj-btn-primary { background: #2c3e66; border-color: #2c3e66; color: #fff; }
      .fj-card .fj-btn-primary:hover { background: #1e2c4d; border-color: #1e2c4d; color: #fff; }
      .fj-card input[type="number"],
      .fj-card select {
        height: 26px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #334155;
        font-size: 12px;
        padding: 0 6px;
      }

      /* 胶囊按钮组 */
      .fj-pill {
        display: inline-flex;
        align-items: stretch;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        overflow: hidden;
        background: #fff;
      }
      .fj-pill button {
        height: 24px;
        padding: 0 10px;
        border: none;
        border-radius: 0;
        background: transparent;
        color: #334155;
        font-size: 12px;
        cursor: pointer;
      }
      .fj-pill button + button { border-left: 1px solid #e2e8f0; }
      .fj-pill button:hover { background: #eef2f7; color: #0f172a; }

      .fj-pill-sm button {
        height: 20px;
        padding: 0 6px;
        font-size: 11px;
      }
      
      .fj-paper > .vertical-content {
        min-height: 0 !important;
        width: 100%;
      }

      /* 预览分页 */
      .fj-pages {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10mm;
        padding: 4px 0;
      }
      .fj-page {
        position: relative;
        background: #fff;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        flex: 0 0 auto;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-end;
        padding: 8mm;
      }      .fj-page .fj-cols {
        display: flex;
        flex-direction: row-reverse;
        align-items: flex-start;
        gap: 2.6mm;
        max-height: 100%;
        max-width: 100%;
      }
      .fj-page .vcol {
        flex: 0 0 auto;
        writing-mode: vertical-rl;
        text-orientation: upright;
        white-space: nowrap;
        overflow: visible;
        text-align: start;
      }

      .vertical-paragraph {
        writing-mode: vertical-rl;
        text-orientation: upright;
        font-size: 14pt;
        white-space: nowrap;
        margin: 0 5px;
        display: inline-block;
        vertical-align: top;
        transition: line-height 0.1s ease;
      }
      .vertical-paragraph.epigraph { font-size: 10pt !important; }
      .vertical-paragraph.compact { margin: 0 0; }
      
      .vertical-content {
        display: flex;
        flex-direction: row-reverse;
        flex-wrap: wrap;
        justify-content: center;
        align-items: flex-start;
        gap: 10px 0;
        min-height: 540px;
        padding-bottom: 10px 5px;
      }
      .vertical-content::-webkit-scrollbar { height: 6px; }
      .vertical-content::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 8px; }
      .vertical-content::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
      
      @media print {
        .fj-title-toolbar, .fj-epigraph-toolbar, .fj-layout-toolbar, .fj-lineheight-toolbar {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(styleAnim);
  }
  
  // 标题工具栏
  const toolbar = document.createElement('div');
  toolbar.className = 'fj-title-toolbar fj-card';
  toolbar.style.cssText = `
    padding: 10px 12px;
  `;
  
  const titleContainer = document.createElement('div');
  titleContainer.style.cssText = `display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;`;
  
  const titleInput = document.createElement('input');
  titleInput.id = 'fj-title-input';
  titleInput.type = 'text';
  titleInput.value = defaultTitle;
  titleInput.style.cssText = `
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    font-size: 0.8rem;
    font-weight: 400;
    font-family: system-ui;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 6px 12px;
    background: #f8fafc;
    color: #64748b;
  `;
  
  subtitleInput.style.cssText = `
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    font-size: 0.8rem;
    font-weight: 400;
    font-family: system-ui;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 6px 12px;
    background: #f8fafc;
    color: #64748b;
  `;
  
  // 第一行：标题字段；第二行：作者字段
  const titleRow = document.createElement('div');
  titleRow.style.cssText = `display: flex; align-items: center; gap: 8px;`;
  titleRow.innerHTML = `<span style="font-size:12px; color:#475569; flex-shrink:0;">标题</span>`;
  titleRow.appendChild(titleInput);
  
  const authorRow = document.createElement('div');
  authorRow.style.cssText = `display: flex; align-items: center; gap: 8px;`;
  authorRow.innerHTML = `<span style="font-size:12px; color:#475569; flex-shrink:0;">作者</span>`;
  authorRow.appendChild(subtitleInput);
  
  titleContainer.appendChild(titleRow);
  titleContainer.appendChild(authorRow);
  
  toolbar.appendChild(titleContainer);
  
  // 题记（并入标题卡片）
  const epigraphToolbar = document.createElement('div');
  epigraphToolbar.className = 'fj-epigraph-toolbar';
  epigraphToolbar.style.cssText = `display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 8px; margin-top: 2px; border-top: 1px dashed #e2e8f0;`;
  epigraphToolbar.innerHTML = `
    <div style="display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: nowrap; white-space: nowrap;">
      <span style="font-size: 12px; color: #475569; flex-shrink: 0;">题记</span>
      <input id="fj-epigraph-count" type="text" inputmode="numeric" value="0" title="标题列后的题记列数" style="width:30px; height:20px; font-size:11px; padding:0 4px; text-align:center; flex-shrink:0;">
      <button id="fj-apply-epigraph" class="fj-btn-primary" title="应用题记设置" style="height:22px; padding:0 6px; font-size:11px; line-height:1; flex-shrink:0;">应用</button>
      <div class="fj-pill fj-pill-sm" title="标题列后的题记列数（点击立即生效）" style="margin-left: auto; flex-shrink: 0;">
        <button id="fj-epigraph-quick-1">1</button>
        <button id="fj-epigraph-quick-2">2</button>
        <button id="fj-epigraph-quick-3">3</button>
        <button id="fj-epigraph-quick-4">4</button>
        <button id="fj-epigraph-quick-5">5</button>
      </div>
    </div>
 `;
  titleContainer.appendChild(epigraphToolbar);
  
  // 布局模式工具栏
  const layoutToolbar = document.createElement('div');
  layoutToolbar.className = 'fj-layout-toolbar fj-card';
  let layoutMode = 'portrait';
  layoutToolbar.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 100%;">
      <span class="fj-card-title" style="flex: 0 1 auto;">版面</span>
      <button id="fj-layout-reset" style="height: 22px; padding: 0 8px; font-size: 11px; line-height: 1;">重置</button>
    </div>
    <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: 1 1 100%;">
      <span class="fj-side-label" style="line-height: 26px;">纸张 尺寸</span>
      <select id="fj-paper-size">
          <option value="A5" selected>A5</option>
          <option value="A4">A4</option>
      </select>
      <span class="fj-side-label" style="margin-left: 4px; line-height: 26px;">方向</span>
      <label style="display: inline-flex; align-items: center; gap: 4px; height: 26px; line-height: 26px; cursor: pointer;"><input type="radio" name="layout-mode" value="portrait" checked style="margin: 0;"> 竖向</label>
      <label style="display: inline-flex; align-items: center; gap: 4px; height: 26px; line-height: 26px; cursor: pointer;"><input type="radio" name="layout-mode" value="landscape" style="margin: 0;"> 横向</label>
    </div>

    <div style="display: flex; align-items: center; gap: 8px; flex: 1 1 100%;">
      <span class="fj-side-label" style="line-height: 26px;">字体</span>
      <div style="position: relative; flex: 1 1 auto; min-width: 0;">
        <input id="fj-font-family" type="text" value="${currentFontFamily}" placeholder="输入或选择字体" style="width: 100%; box-sizing: border-box; height: 26px; padding: 0 46px 0 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #334155; -webkit-appearance: none; appearance: none;">
        <button id="fj-font-clear" type="button" title="清空" style="position: absolute; right: 25px; top: 1px; width: 20px; height: 24px; display: none; align-items: center; justify-content: center; background: transparent; border: none; padding: 0; font-size: 12px; line-height: 1; color: #94a3b8; cursor: pointer;">✕</button>
        <button id="fj-font-toggle" type="button" style="position: absolute; right: 1px; top: 1px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 0; line-height: 1; cursor: pointer;">
          <svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="#64748b" stroke-width="1.4"/></svg>
        </button>
        <div id="fj-font-panel" style="display: none; position: absolute; left: 0; right: 0; top: 100%; margin-top: 3px; max-height: 60vh; overflow-y: auto; overflow-x: hidden; resize: both; min-width: 200px; min-height: 90px; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; box-shadow: 0 6px 16px rgba(15, 23, 42, 0.12); z-index: 1000001; font-size: 12px; color: #334155;"></div>
      </div>
      <button id="fj-font-refresh" type="button" title="重新读取系统字体" style="width: 26px; height: 26px; padding: 0; font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center; border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; color: #475569; cursor: pointer;">↻</button>
    </div>

    <div style="display: flex; align-items: center; flex-wrap: wrap; column-gap: 20px; row-gap: 8px; flex: 1 1 100%;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="fj-side-label">字号</span>
        <button id="fj-fontsize-minus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">−</button>
        <input id="fj-fontsize-val" type="text" inputmode="numeric" value="${currentFontSize}" title="直接填写字号（8–26pt）" style="width: 34px; height: 22px; box-sizing: border-box; padding: 0 2px; text-align: center; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155;">
        <button id="fj-fontsize-plus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">+</button>
        <button id="fj-bold-toggle" title="正文加粗" style="width: 22px; height: 22px; padding: 0; margin-left: 4px; font-size: 13px; font-weight: 700; line-height: 1; font-family: system-ui, -apple-system, 'Microsoft YaHei', sans-serif; color: ${currentBold ? '#fff' : '#334155'}; background: ${currentBold ? '#2c3e66' : '#f8fafc'};">B</button>
        <button id="fj-color-black" title="正文用纯黑色" style="width: 22px; height: 22px; padding: 0; margin-left: 4px; font-size: 11px; line-height: 1; font-family: system-ui, sans-serif; color: ${currentBodyColor === '#000000' ? '#fff' : '#111827'}; background: ${currentBodyColor === '#000000' ? '#2c3e66' : '#f8fafc'};">黑</button>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="fj-side-label" title="竖排时行距即列宽">列宽</span>
        <button id="fj-lineheight-minus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">−</button>
        <input id="fj-lineheight-val" type="text" inputmode="decimal" value="${currentLineHeight.toFixed(1)}" title="直接填写列宽（1.0–3.0 倍字号）" style="width: 38px; height: 22px; box-sizing: border-box; padding: 0 2px; text-align: center; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155;">
        <button id="fj-lineheight-plus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">+</button>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;" title="字间距：竖排时字与字之间的空隙">
        <span class="fj-side-label">字距</span>
        <button id="fj-letterspacing-minus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">−</button>
        <input id="fj-letterspacing-val" type="text" inputmode="decimal" value="${currentLetterSpacing}" title="直接填写字间距（-3–12）" style="width: 34px; height: 22px; box-sizing: border-box; padding: 0 2px; text-align: center; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155;"><span style="font-size: 11px; color: #94a3b8; margin-left: 2px;">px</span>
        <button id="fj-letterspacing-plus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">+</button>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="fj-side-label">页边距</span>
        <button id="fj-margin-minus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">−</button>
        <input id="fj-margin-val" type="text" inputmode="numeric" value="${currentMarginMm}" title="直接填写页边距（2–30mm）" style="width: 34px; height: 22px; box-sizing: border-box; padding: 0 2px; text-align: center; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155;"><span style="font-size: 11px; color: #94a3b8; margin-left: 2px;">mm</span>
        <button id="fj-margin-plus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">+</button>
        <div class="fj-pill fj-pill-sm" style="margin-left: 4px;">
          <button id="fj-margin-quick-narrow" style="padding: 0 7px; font-size: 10px;">窄</button>
          <button id="fj-margin-quick-mid" style="padding: 0 7px; font-size: 10px;">中</button>
          <button id="fj-margin-quick-wide" style="padding: 0 7px; font-size: 10px;">宽</button>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;" title="装订线：额外加在内侧（装订侧）的边距；开「奇偶对称」时奇数页在右、偶数页在左">
        <span class="fj-side-label">装订线</span>
        <button id="fj-gutter-minus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">−</button>
        <input id="fj-gutter-val" type="text" inputmode="numeric" value="${currentGutterMm}" title="直接填写装订线（0–30mm）" style="width: 34px; height: 22px; box-sizing: border-box; padding: 0 2px; text-align: center; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155;"><span style="font-size: 11px; color: #94a3b8; margin-left: 2px;">mm</span>
        <button id="fj-gutter-plus" style="width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;">+</button>
      </div>
    </div>

    <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1 1 100%;">
      <span class="fj-side-label">底纹</span>
      <label title="给纸张加上仿古籍的旧纸底纹（预览、打印、下载图片都会带上）" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-antique-paper" style="margin: 0; cursor: pointer;">
        <span>纸</span>
      </label>
      <label title="加淡墨双线版框和界行（古籍刻本样式）" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-antique-frame" style="margin: 0; cursor: pointer;">
        <span>框</span>
      </label>
      <label title="版框横向满页：剩余宽度平摊给本页各列，列宽略大于版面设定的列宽" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-frame-fullpage" style="margin: 0; cursor: pointer;">
        <span>满</span>
      </label>
      <label title="模拟手刻版：外框粗线微微弯曲、墨色不均，内细线与界行断断续续（同一页每次渲染/打印都一致）" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-frame-rough" style="margin: 0; cursor: pointer;">
        <span>旧</span>
      </label>
      <label title="在版心外侧标中文数字页码" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-page-number" style="margin: 0; cursor: pointer;">
        <span>码</span>
      </label>
      <label title="奇偶页对称：奇数页页码在左、偶数页在右，有页码一侧的页边距减去半个页码列宽" style="display: inline-flex; align-items: center; gap: 5px; height: 22px; line-height: 22px; cursor: pointer;">
        <input type="checkbox" id="fj-page-number-mirror" style="margin: 0; cursor: pointer;">
        <span>称</span>
      </label>
    </div>
  `;

  // 仿古纸底纹开关
  const antiqueToggle = layoutToolbar.querySelector('#fj-antique-paper');
  if (antiqueToggle) {
    antiqueToggle.checked = currentAntiquePaper;
    antiqueToggle.addEventListener('change', () => {
      currentAntiquePaper = antiqueToggle.checked;
      renderPreviewPages();
      try { chrome.storage.local.set({ antiquePaper: currentAntiquePaper }); } catch (e) {}
      showToast(currentAntiquePaper ? '📜 已启用仿古籍纸底纹' : '已关闭仿古籍纸底纹', 1200);
    });
  }

  // 版框开关
  const frameToggle = layoutToolbar.querySelector('#fj-antique-frame');
  if (frameToggle) {
    frameToggle.checked = currentAntiqueFrame;
    frameToggle.addEventListener('change', () => {
      currentAntiqueFrame = frameToggle.checked;
      // 版框会占去上下留白，列可容纳字数变化 → 需要重新切列
      renderVerticalContent(window.editedText || text, false);
      renderPreviewPages();
      try { chrome.storage.local.set({ antiqueFrame: currentAntiqueFrame }); } catch (e) {}
      showToast(currentAntiqueFrame ? '已加上古籍版框' : '已关闭版框', 1200);
    });
  }

  // 「满页」开关：版框宽度撑满版心，剩余宽度平摊给本页各列
  const frameFullToggle = layoutToolbar.querySelector('#fj-frame-fullpage');
  if (frameFullToggle) {
    frameFullToggle.checked = currentFrameFullPage;
    frameFullToggle.addEventListener('change', () => {
      currentFrameFullPage = frameFullToggle.checked;
      renderPreviewPages();
      try { chrome.storage.local.set({ frameFullPage: currentFrameFullPage }); } catch (e) {}
      showToast(currentFrameFullPage ? '版框已改为满页' : '版框按整列收边', 1200);
    });
  }

  // 「做旧」开关：线条带手工刻版式抖动，界行断续
  const frameRoughToggle = layoutToolbar.querySelector('#fj-frame-rough');
  if (frameRoughToggle) {
    frameRoughToggle.checked = currentFrameRough;
    frameRoughToggle.addEventListener('change', () => {
      currentFrameRough = frameRoughToggle.checked;
      renderPreviewPages();
      try { chrome.storage.local.set({ frameRough: currentFrameRough }); } catch (e) {}
      showToast(currentFrameRough ? '版框已做旧' : '版框恢复规整线条', 1200);
    });
  }
  
  // 页码开关（页码画在版框上，需要版框开着才显示）
  const pageNumberToggle = layoutToolbar.querySelector('#fj-page-number');
  if (pageNumberToggle) {
    pageNumberToggle.checked = currentPageNumber;
    pageNumberToggle.addEventListener('change', () => {
      currentPageNumber = pageNumberToggle.checked;
      if (currentPageNumber && !currentAntiqueFrame) showToast('页码需要配合「版框」显示', 1500);
      renderPreviewPages();
      try { chrome.storage.local.set({ pageNumber: currentPageNumber }); } catch (e) {}
      showToast(currentPageNumber ? '已显示页码' : '已隐藏页码', 1200);
    });
  }

  // 奇偶页对称：奇数页页码在左、偶数页页码在右，页码一侧页边距减半个页码列宽
  const pageNumberMirrorToggle = layoutToolbar.querySelector('#fj-page-number-mirror');
  if (pageNumberMirrorToggle) {
    pageNumberMirrorToggle.checked = currentPageNumberMirror;
    pageNumberMirrorToggle.addEventListener('change', () => {
      currentPageNumberMirror = pageNumberMirrorToggle.checked;
      // 只影响页码落在哪一侧，版心与分页不变，重画页面即可
      renderPreviewPages();
      try { chrome.storage.local.set({ pageNumberMirror: currentPageNumberMirror }); } catch (e) {}
      showToast(currentPageNumberMirror ? '已启用奇偶页对称' : '已关闭奇偶页对称', 1200);
    });
  }
  
  /*
  const lineHeightToolbar = document.createElement('div');
  lineHeightToolbar.className = 'fj-lineheight-toolbar';
  lineHeightToolbar.style.cssText = `
    padding: 8px 20px;
    border-bottom: 1px solid #e2e8f0;
    background: #fef3f2;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.8rem;
    font-family: system-ui;
  `;
  lineHeightToolbar.innerHTML = `
  `;
  */
  
  // 内容区域
  // 左栏：纸张预览
  const previewCol = document.createElement('div');
  previewCol.className = 'fj-preview-col';
  previewCol.style.cssText = `flex: 0 0 auto; padding: 12px; overflow: auto; display: flex; align-items: flex-start; justify-content: center; background: #eef2f7;`;

  const contentArea = document.createElement('div');
  contentArea.className = 'fj-paper';
  contentArea.style.cssText = `box-sizing: border-box; width: 148mm; height: 210mm; flex: 0 0 auto; padding: 16px 16px; background: white; overflow-y: auto; display: flex; flex-direction: column; justify-content: center; align-items: center; position: absolute; left: -10000px; top: 0;`;

  const pagesWrap = document.createElement('div');
  pagesWrap.className = 'fj-pages';

  // 右栏：编辑区
  const sidebar = document.createElement('div');
  sidebar.className = 'fj-sidebar';
  sidebar.style.cssText = `flex: 0 0 330px; display: flex; flex-direction: column; gap: 10px; padding: 12px; min-height: 0; background: #f1f5f9; border-left: 1px solid #e2e8f0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: thin;`;

  // 右栏标题栏
  const sideHeader = document.createElement('div');
  sideHeader.className = 'fj-side-header';
  sideHeader.style.cssText = `display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 2px 2px; position: sticky; top: 0; z-index: 10; background: #f1f5f9; font-family: system-ui, sans-serif;`;
  sideHeader.innerHTML = `
    <span id="fj-side-title-text" style="font-size: 13px; font-weight: 600; color: #1e293b; letter-spacing: 0.5px;">元素图文 · 时见 · 古文竖排</span>
    <button id="fj-close-panel" style="background: none; border: none; font-size: 1.3rem; line-height: 1; cursor: pointer; color: #64748b; padding: 2px 4px;">✕</button>
  `;
  
  // ========== 功能函数 ==========
  
  function updateLineHeight(value) {
    currentLineHeight = value;
    const valSpan = document.getElementById('fj-lineheight-val');
    if (valSpan) setFieldValue(valSpan, value.toFixed(1));
    // 行距变了，每列字数随之改变，重新切列排版（保留用户设定的行距）
    renderVerticalContent(window.editedText || text, false);
    const epgCount = getEpigraphCount();
    if (epgCount > 0) applyEpigraphFormat();
    schedulePreviewPages();
    showToast(`行距调整为 ${value.toFixed(1)}`, 1000);
    try { chrome.storage.local.set({ lineHeight: value }); } catch (e) {}
  }
  
  function applyLayoutMode(mode) {
    const verticalContent = contentArea.querySelector('.vertical-content');
    if (!verticalContent) return;
    /*
    if (mode === 'portrait') {
      verticalContent.style.flexWrap = 'nowrap';
      verticalContent.style.overflowX = 'auto';
      verticalContent.style.overflowY = 'hidden';
    } else {
      verticalContent.style.flexWrap = 'wrap';
      verticalContent.style.overflowX = 'visible';
      verticalContent.style.overflowY = 'visible';
      verticalContent.style.minHeight = '250px';
    }
    */
    verticalContent.style.flexWrap = 'wrap';
    verticalContent.style.overflowX = 'visible';
    verticalContent.style.overflowY = 'visible';
    verticalContent.style.minHeight = '250px';   
    layoutMode = mode;
    schedulePreviewPages();
  }
  
  // ========== 预览分页（与打印同一套算法） ==========
  let pagesRefreshTimer = null;
  function schedulePreviewPages() {
    if (pagesRefreshTimer) clearTimeout(pagesRefreshTimer);
    pagesRefreshTimer = setTimeout(() => { pagesRefreshTimer = null; renderPreviewPages(); }, 60);
  }

  function computePages() {
    // 与打印共用同一套分页模型
    return buildPageModel(contentArea.querySelectorAll('.vertical-paragraph'), { paperSize: currentPaperSize, orientation: layoutMode, marginMm: currentMarginMm });
  }

  // 用 DOM 真实位置校正版框：框始终占满正文带（不随文字多少伸缩），
  // 这里只按页面实际内边距把框顶和高度对齐到页边距内，避免和纸张/文字错位
  function syncFrameGeometry() {
    if (!pagesWrap || !currentAntiqueFrame) return;
    const padYPx = Math.round(FRAME_PAD_Y_MM * PX_PER_MM);
    Array.from(pagesWrap.querySelectorAll('.fj-page')).forEach((pageEl) => {
      const frame = pageEl.querySelector('.fj-frame');
      if (!frame) return;
      const cs = getComputedStyle(pageEl);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const bandInnerH = pageEl.clientHeight - padTop - padBottom;
      if (bandInnerH <= 0) return;
      const bandMin = Math.max(0, padTop - padYPx);   // = 上页边距
      const h = bandInnerH + padYPx * 2;
      frame.style.top = Math.round(bandMin) + 'px';
      frame.style.height = Math.round(h) + 'px';
    });
  }

  function renderPreviewPages() {
    if (!pagesWrap) return;
    const { pages, pageWmm, pageHmm, MARGIN_MM } = computePages();
    // 标题右侧显示总页数
    const pageCountEl = document.getElementById('fj-page-count');
    if (pageCountEl) pageCountEl.textContent = pages.length ? `共 ${pages.length} 页` : '';
    if (!pages.length) { pagesWrap.innerHTML = ''; return; }
    const innerHmm = pageHmm - MARGIN_MM * 2;
    // 开版框时，正文带上下各让出 padY，文字被限制在带宽内，框再往外扩 padY
    const framePadY = currentAntiqueFrame ? FRAME_PAD_Y_MM : 0;
    const bandHmm = innerHmm - framePadY * 2;

    pagesWrap.innerHTML = pages.map((colsOfPage, pageIndex) => {
      const pm = pageMargins(pageIndex + 1);
      // 「满页」模式：按版面设定的列距算本页能放下的整列数（含左侧空白列），
      // 不足一列的余量舍弃，剩余宽度按总列数平摊 → 列宽略大于设定值
      const availWmm = pageWmm - pm.left - pm.right;
      const baseWmm = (colsOfPage[0] && colsOfPage[0].naturalWidthPx)
        ? colsOfPage[0].naturalWidthPx / PX_PER_MM
        : (colsOfPage[0] ? colsOfPage[0].widthPx / PX_PER_MM : 0);
      const pitchMm = baseWmm + 2.6;
      let slots = pitchMm > 0 ? Math.floor((availWmm + 2.6) / pitchMm) : 0;
      slots = Math.max(slots, colsOfPage.length, 1);
      const effWmm = currentFrameFullPage ? (availWmm - 2.6 * (slots - 1)) / slots : 0;
      const colsHtml = colsOfPage.map((col) => `
        <div class="vcol" style="width:${(effWmm > 0 ? effWmm : col.widthPx / PX_PER_MM).toFixed(2)}mm;font-size:${col.fontSize};line-height:${col.lineHeight};font-weight:${col.fontWeight};letter-spacing:${col.letterSpacing || 'normal'};color:${col.color || '#1e293b'};font-family:'${currentFontFamily}', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif;">${col.html}</div>
      `).join('');
      const frameHtml = buildPageFrame(colsOfPage, bandHmm, MARGIN_MM, pageIndex + 1, pageWmm, effWmm, slots);
      return `<div class="fj-page" data-page="${pageIndex + 1}" style="width:${pageWmm}mm;height:${pageHmm}mm;padding:${MARGIN_MM + framePadY}mm ${pm.right}mm ${MARGIN_MM + framePadY}mm ${pm.left}mm;${currentAntiquePaper ? antiquePaperBackground() : ''}"><div class="fj-cols">${colsHtml}</div>${frameHtml}</div>`;
    }).join('');
    // 渲染完立即按真实位置校正框的上下边界（预览、打印、导图都吃这套内联样式）
    syncFrameGeometry();
    // 字体/排版可能晚一帧才稳定，再校一次
    requestAnimationFrame(syncFrameGeometry);
  }

  // 题记列号从“标题/作者列”之后开始计数
  function getBodyColumnOffset() {
    const first = contentArea.querySelector('.vertical-content .vertical-paragraph');
    if (!first) return 0;
    const style = first.getAttribute('style') || '';
    return style.includes('bold') ? 1 : 0;
  }

  // 题记列数：标题列之后的 n 列
  function getEpigraphCount() {
    let n = parseInt(document.getElementById('fj-epigraph-count')?.value || '0', 10);
    return isNaN(n) ? 0 : n;
  }

  function applyEpigraphFormat() {
    console.log('[DEBUG] ===== applyEpigraphFormat 按钮点击 =====');
    
    const count = getEpigraphCount();
    console.log('[DEBUG] 题记列数:', count);
    
    const verticalContentDiv = contentArea.querySelector('.vertical-content');
    if (!verticalContentDiv) {
      console.error('[ERROR] 未找到 .vertical-content 元素');
      showToast('❌ 未找到内容区域', 1500);
      return;
    }
    
    const allParagraphs = verticalContentDiv.querySelectorAll('.vertical-paragraph');
    const currentCount = allParagraphs.length;
    console.log('[DEBUG] 当前共有列数:', currentCount);
    
    allParagraphs.forEach(para => para.classList.remove('epigraph'));
    
    if (count <= 0) {
      console.log('[DEBUG] 清除题记范围');
      showToast('📜 题记范围已清除', 1200);
      return;
    }
    
    const offset = getBodyColumnOffset();
    let startIndex = offset;
    let endIndex = offset + count - 1;
    
    if (startIndex >= allParagraphs.length) {
      showToast(`⚠️ 列范围超出（共 ${allParagraphs.length - offset} 列正文）`, 1500);
      return;
    }
    if (endIndex >= allParagraphs.length) {
      endIndex = allParagraphs.length - 1;
      showToast(`⚠️ 只有 ${allParagraphs.length - offset} 列正文，已取到最后一列`, 1500);
    }
    
    /*
    for (let i = startIndex; i <= endIndex; i++) {
      if (allParagraphs[i]) {
        allParagraphs[i].classList.add('epigraph');
        console.log(`[DEBUG] ✅ 段落 ${i} 已添加 epigraph 类`);
      }
    }
    
    const finalCount = verticalContentDiv.querySelectorAll('.vertical-paragraph.epigraph').length;
    console.log(`[DEBUG] 最终添加了 ${finalCount} 个 epigraph`);
    //showToast(`📜 已应用题记：从右起第 ${startCol} 至 ${endCol} 列`, 1500);
    */
    
    // 题记列每列字数上限改为50，有可能列数减少
    // 保存原始文字（如果没有保存过）
    for (let i = 0; i < allParagraphs.length; i++) {
      if (!allParagraphs[i].originalText) {
        allParagraphs[i].originalText = allParagraphs[i].innerText || allParagraphs[i].textContent;
      }
    }
    
    // 收集题记范围内的文字（列号从标题列之后开始算）
    let epigraphText = '';
    let oldEpigraphCount = 0;
    const columnsToReplace = [];
    
    for (let i = startIndex; i <= endIndex; i++) {
      epigraphText += allParagraphs[i].originalText;
      columnsToReplace.push(allParagraphs[i]);
    }
    
    oldEpigraphCount = columnsToReplace.length;
    console.log(`[DEBUG] 题记范围共 ${columnsToReplace.length} 列，合并后 ${epigraphText.length} 字`);
    
    // 按 50 字重新拆分
    const maxCharsEpigraph = 50;
    const epigraphColumns = sliceColumnText(epigraphText, maxCharsEpigraph);
    const newColumnCount = epigraphColumns.length;
    
    if (oldEpigraphCount > 1) {
        console.log(`[DEBUG] 重新拆分为 ${newColumnCount} 列（50字/列）`);
        
        // 创建新列
        const newColumns = [];
        for (const colText of epigraphColumns) {
          const newDiv = document.createElement('div');
          newDiv.className = 'vertical-paragraph epigraph';
          newDiv.innerText = colText;
          newDiv.originalText = colText;
          newDiv.style.lineHeight = currentLineHeight;
          newColumns.push(newDiv);
        }
        
        // 替换原有的列
        const parent = verticalContentDiv;
        const firstCol = columnsToReplace[0];
        const lastCol = columnsToReplace[columnsToReplace.length - 1];
        
        // 创建文档片段
        const fragment = document.createDocumentFragment();
        newColumns.forEach(col => fragment.appendChild(col));
        
        // 找到插入位置
        if (firstCol.parentNode === parent) {
          // 替换：先移除旧列，再插入新列
          let currentNode = firstCol;
          const nodesToRemove = [];
          while (currentNode && currentNode !== lastCol.nextSibling) {
            nodesToRemove.push(currentNode);
            currentNode = currentNode.nextSibling;
          }
          
          // 在第一个旧列的位置插入新列
          if (firstCol.previousSibling) {
            parent.insertBefore(fragment, firstCol);
          } else {
            parent.insertBefore(fragment, firstCol);
          }
          
          // 移除旧列
          nodesToRemove.forEach(node => node.remove());
        }
        
        // 更新后续列的索引（如果需要）
        const finalEpigraphCount = parent.querySelectorAll('.vertical-paragraph.epigraph').length;
        console.log(`[DEBUG] 题记列数量变化: ${columnsToReplace.length} 列 → ${newColumns.length} 列`);
        
        showToast(`📜 已应用题记：标题列后 ${count} 列合并为 ${newColumns.length} 列（50字/列）`, 2000);
      } else {
          console.log(`[DEBUG] 题记1列，无需合并`);
             for (let i = startIndex; i <= endIndex; i++) {
              if (allParagraphs[i]) {
                allParagraphs[i].classList.add('epigraph');
                console.log(`[DEBUG] ✅ 段落 ${i} 已添加 epigraph 类`);
              }
            }
            
            const finalCount = verticalContentDiv.querySelectorAll('.vertical-paragraph.epigraph').length;
            console.log(`[DEBUG] 最终添加了 ${finalCount} 个 epigraph`);
            //showToast(`📜 已应用题记：从右起第 ${startCol} 至 ${endCol} 列`, 1500);
     }
     schedulePreviewPages();
  }
  
  function updateEpigraphFormat() {
    console.log('[DEBUG] ===== updateEpigraphFormat 开始执行 =====');
    
    const count = getEpigraphCount();
    console.log('[DEBUG] 题记列数:', count);
    
    // 获取正确的垂直内容容器
    const verticalContentDiv = contentArea.querySelector('.vertical-content');
    console.log('[DEBUG] .vertical-content 元素:', verticalContentDiv);
    
    if (!verticalContentDiv) {
      console.error('[ERROR] 未找到 .vertical-content 元素！');
      return;
    }
    
    const allParagraphs = verticalContentDiv.querySelectorAll('.vertical-paragraph');
    console.log('[DEBUG] 找到 .vertical-paragraph 数量:', allParagraphs.length);
    
    // 先清除所有 epigraph 类
    allParagraphs.forEach(para => para.classList.remove('epigraph'));
    
    // 如果列数无效，直接返回
    if (count <= 0) {
      console.log('[DEBUG] 题记列数无效，退出');
      return;
    }
    
    const offset = getBodyColumnOffset();
    const startIndex = offset;
    const endIndex = Math.min(offset + count - 1, allParagraphs.length - 1);
    console.log('[DEBUG] 计算的索引范围 - startIndex:', startIndex, 'endIndex:', endIndex);
    
    // 应用题记样式
    for (let i = startIndex; i <= endIndex; i++) {
      if (allParagraphs[i]) {
        allParagraphs[i].classList.add('epigraph');
      }
    }
    
    // 验证结果
    const epigraphCount = verticalContentDiv.querySelectorAll('.vertical-paragraph.epigraph').length;
    console.log(`[DEBUG] 应用题记完成，共 ${epigraphCount} 个段落获得了 epigraph 类`);
    
    console.log('[DEBUG] ===== updateEpigraphFormat 执行完毕 =====');
  }
  
  //拼接标题和副标题，正文按每列最多字拆分成多列，自动调整行距
  function renderVerticalContent(sourceText, autoLineHeight = true) {
    console.log('[DEBUG] renderVerticalContent 开始执行, sourceText 长度:', sourceText?.length);
    
    const titleText = titleInput.value || '无标题';
    const subtitleText = subtitleInput.value || '';
    console.log('[DEBUG] 标题:', titleText, '副标题:', subtitleText);
    
    let titleHtml = '';
    if (subtitleText && subtitleText.trim() !== '') {
      titleHtml = `<div class="vertical-paragraph" style="font-weight: bold; margin-bottom: 20px;">
        ${escapeHtml(titleText)}&emsp;<span style="font-size: 11pt; font-weight: normal;">${escapeHtml(subtitleText.trim())}</span>
      </div>`;
    } else {
      titleHtml = `<div class="vertical-paragraph" style="font-weight: bold;">${escapeHtml(titleText)}</div>`;
    }
    
    //const paragraphs = sourceText.split(/\n+/);
    const paragraphs = sourceText.split(/\n/);
    let contentHtml = '';
    let totalColumns = 0;
    let columnCount = 0;
    
    // 获取每列最大字数（按纸张可用高度实测，随字号/行距动态变化）
    const maxChars = getMaxCharsPerColumn(currentPaperSize, Math.max(currentLineHeight, 1.5), layoutMode);
    console.log("[DEBUG] maxChars: ", maxChars);
    
    for (let para of paragraphs) {
      //console.log('[DEBUG] para:', para);
      //if (para.trim() === '') continue;
      //if (para === '') continue;
      //const chars = para.trim().split('');
      //console.log('[DEBUG] chars:', chars, 'length:', chars.length);
      //const maxChars = 37;
      if (para.trim() === '') {
          columnCount = 1;
          // 空白行：用全角空格撑出一个完整宽度的空列（空 div 宽度为 0，翻页时会被丢掉）
          contentHtml += `<div class="vertical-paragraph">　</div>`;
      }else {
          const colTexts = sliceColumnText(para, maxChars);
          columnCount = colTexts.length;
          for (const colText of colTexts) {
            contentHtml += `<div class="vertical-paragraph" style="font-weight: ${currentBold ? 'bold' : 'normal'};${currentBodyColor ? ` color: ${currentBodyColor};` : ''}">${escapeHtml(colText)}</div>`;
          }
      }
      totalColumns += columnCount;
    }
    const totalCount = 1 + totalColumns;
    console.log('[DEBUG] 总列数:', totalCount, '内容列数:', totalColumns);
    // 当前总列数赋值给全局变量
    currentColumnCount = totalCount;

    contentArea.innerHTML = `<div class="vertical-content">${titleHtml}${contentHtml}</div>`;
    //console.log('[DEBUG] DOM 已更新, innerHTML 长度:', contentArea.innerHTML.length);
    
    // 应用当前行距
    let allParagraphs = contentArea.querySelectorAll('.vertical-paragraph');
    console.log('[DEBUG] 找到 .vertical-paragraph 数量:', allParagraphs.length);
    allParagraphs.forEach(para => {
      para.style.lineHeight = currentLineHeight;
      para.style.fontFamily = `'${currentFontFamily}', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif`;
      if (!para.classList.contains('epigraph')) {
        para.style.fontSize = currentFontSize + 'pt';
        para.style.letterSpacing = currentLetterSpacing ? currentLetterSpacing + 'px' : '';
      }
    });

    // 超过8列时，自动把行距调整为1；超过4列时，调整为1.5（仅首次渲染时自动，用户手动设定后不再覆盖）
    let targetLineHeight = currentLineHeight;
    if (autoLineHeight) {
      if (totalCount > 8) {
        targetLineHeight = 1.0;
        if (currentLineHeight !== 1.0) {
          showToast(`📊 共 ${totalCount} 列，已自动调整为紧凑行距 1.0`, 1500);
        }
      } else if (totalCount > 4){
        targetLineHeight = 1.5;
        if (currentLineHeight !== 1.5) {
            showToast(`📊 共 ${totalCount} 列，已自动调整为中等行距 1.5`, 1500);
        }
      }
    }
    
    allParagraphs.forEach(para => {
      para.style.lineHeight = targetLineHeight;
    });
    
    currentLineHeight = targetLineHeight;

    const valSpan = document.getElementById('fj-lineheight-val');
    if (valSpan) setFieldValue(valSpan, currentLineHeight.toFixed(1));
    
    // 应用布局模式
    applyLayoutMode(layoutMode);
    
    // 紧凑模式
    if (layoutMode === 'landscape' && totalCount > 10) {
      allParagraphs.forEach(para => para.classList.add('compact'));
    } else if (layoutMode === 'landscape') {
      allParagraphs.forEach(para => para.classList.remove('compact'));
    }

    schedulePreviewPages();
  }

  /**
   * 清理正文中的括号及其内容
   */
  function cleanBracketsAndContent() {
    // 优先取正文输入框里的最新内容（含已应用的标点替换），避免回退到原始文本
    const bodyEl = document.getElementById('fj-body-text');
    let currentText = (bodyEl && bodyEl.value) ? bodyEl.value : (window.editedText || windowEditedText || text);
    
    if (!currentText || currentText.trim() === '') {
      showToast('⚠️ 没有可清理的内容', 1500);
      return;
    }
    
    const originalLength = currentText.length;
    
    // 定义括号匹配规则
    const bracketPairs = [
      { open: '(', close: ')' },
      { open: '（', close: '）' },
      { open: '[', close: ']' },
      { open: '【', close: '】' },
      { open: '{', close: '}' },
      { open: '｛', close: '｝' }
    ];
    
    let cleanedText = currentText;
    let removedCount = 0;
    
    bracketPairs.forEach(pair => {
      const openEscaped = pair.open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const closeEscaped = pair.close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${openEscaped}[^${openEscaped}${closeEscaped}]*${closeEscaped}`, 'g');
      
      const matches = cleanedText.match(regex);
      if (matches) {
        removedCount += matches.length;
      }
      
      cleanedText = cleanedText.replace(regex, '');
    });
    
    cleanedText = cleanedText.replace(/\n\s*\n\s*\n/g, '\n\n');
    cleanedText = cleanedText.replace(/[ \t]+/g, '');
    cleanedText = cleanedText.trim();
    
    if (cleanedText === currentText) {
      showToast('📝 未找到括号内容', 1500);
      return;
    }
    
    const removedChars = originalLength - cleanedText.length;
    
    // 更新编辑后的文本
    editedText = cleanedText;
    
    // 重新渲染
    renderVerticalContent(cleanedText, false);

    // 同步到正文输入框（点「清括号」即时生效，无需再点应用）
    if (bodyEl) {
      bodyEl.value = cleanedText;
      bodyEl.dispatchEvent(new Event('input'));
    }
    
    showToast(`🧽 已清理 ${removedCount} 处括号，移除 ${removedChars} 个字符`, 2000);
  }
  
  // 正文编辑：常驻在右栏底部，不再弹窗
  const initialBodyText = windowEditedText || text;

  const editSection = document.createElement('div');
  editSection.className = 'fj-edit-section fj-card';
  editSection.style.cssText = `display: flex; flex-direction: column; align-items: stretch; gap: 6px; flex: 0 0 auto; min-height: 0; padding: 10px 12px; margin: 0;`;

  const editHeader = document.createElement('div');
  editHeader.style.cssText = `display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto;`;
  editHeader.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
      <span class="fj-card-title" style="flex: 1 1 auto;">正文</span>
      <div style="display: flex; gap: 6px;">
        <button id="fj-body-max" style="height: 22px; width: 22px; padding: 0; font-size: 12px; line-height: 1;" title="最大化编辑">⤢</button>
        <button id="fj-auto-split" style="height: 22px; width: 22px; padding: 0; font-size: 12px; line-height: 1;" title="自动分段：句号、叹号、问号后断行（每句一列）">¶</button>
        <button id="fj-vertical-punct" style="height: 22px; padding: 0 8px; font-size: 11px; line-height: 1;" title="把标点换成竖排（古籍）用法：书名号→「」、引号→「」『』、半角→全角">竖排标点</button>
        <button id="fj-clean-brackets" style="height: 22px; padding: 0 8px; font-size: 11px; line-height: 1;" title="清理括号及其内容">清括号</button>
        <button id="fj-cancel-edit" style="height: 22px; padding: 0 8px; font-size: 11px; line-height: 1;">还原</button>
      </div>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px;">
      <span style="font-size: 11px; color: #64748b;">每行一段，Ctrl+Enter 应用</span>
      <button id="fj-save-edit" class="fj-btn-primary" style="height:22px; padding:0 8px; font-size:11px; line-height:1;">应用</button>
    </div>`;

  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.id = 'fj-body-text';
  bodyTextarea.value = initialBodyText;
  bodyTextarea.style.cssText = `box-sizing: border-box; display: block; width: 100%; flex: 0 0 auto; min-height: 80px; height: 80px; max-height: 100%; margin: 0; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.6; border: 1px solid #cbd5e1; border-radius: 8px; resize: none; background: #f8fafc; color: #1e293b; overflow-y: hidden;`;

  editSection.appendChild(editHeader);
  editSection.appendChild(bodyTextarea);

  function applyBodyText() {
    const val = bodyTextarea.value;
    if (!val || val.trim() === '') {
      showToast('⚠️ 内容不能为空', 1500);
      return;
    }
    window.editedText = val;
    renderVerticalContent(val, false);
    showToast('✅ 预览已更新', 1200);
  }

  const saveEditBtn = editHeader.querySelector('#fj-save-edit');
  const cancelEditBtn = editHeader.querySelector('#fj-cancel-edit');

  saveEditBtn.onclick = applyBodyText;
  cancelEditBtn.onclick = () => {
    bodyTextarea.value = initialBodyText;
    window.editedText = null;
    renderVerticalContent(initialBodyText, false);
    autoResizeBody();
    showToast('📝 已还原', 1200);
  };
  bodyTextarea.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') applyBodyText();
  });

  // 编辑框高度随内容自适应，但不超过右栏剩余高度
  function autoResizeBody() {
    if (bodyMaximized) return;
    if (!sidebar.clientHeight) return;
    let used = 0;
    Array.from(sidebar.children).forEach(el => {
      if (el !== editSection) used += el.offsetHeight;
    });
    const count = sidebar.children.length;
    const gaps = 10 * (count - 1);
    const availCard = sidebar.clientHeight - used - gaps - 24;
    const maxH = Math.max(80, availCard - editHeader.offsetHeight - 6 - 20);
    bodyTextarea.style.height = 'auto';
    const need = bodyTextarea.scrollHeight + 2;
    bodyTextarea.style.height = Math.min(need, maxH) + 'px';
    bodyTextarea.style.overflowY = need > maxH ? 'auto' : 'hidden';
  }
  bodyTextarea.addEventListener('input', autoResizeBody);
  window.addEventListener('resize', autoResizeBody);
  setTimeout(autoResizeBody, 150);

  // 正文编辑器最大化：铺满整个预览浮层
  let bodyMaximized = false;
  const bodyMaxBtn = editHeader.querySelector('#fj-body-max');
  const toggleBodyMax = () => {
    bodyMaximized = !bodyMaximized;
    if (bodyMaximized) {
      const r = panel.getBoundingClientRect();
      editSection.dataset.prevCss = editSection.style.cssText;
      editSection.style.cssText = `position: fixed; left: ${r.left}px; top: ${r.top}px; width: ${r.width}px; height: ${r.height}px; z-index: 1000002; margin: 0; padding: 14px 16px; box-sizing: border-box; display: flex; flex-direction: column; align-items: stretch; gap: 8px; background: #fff; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.25);`;
      bodyTextarea.style.cssText = `box-sizing: border-box; display: block; width: 100%; flex: 1 1 auto; min-height: 0; height: auto; margin: 0; padding: 14px; font-family: monospace; font-size: 13px; line-height: 1.7; border: 1px solid #cbd5e1; border-radius: 8px; resize: none; background: #f8fafc; color: #1e293b; overflow-y: auto;`;
      if (bodyMaxBtn) { bodyMaxBtn.textContent = '⤡'; bodyMaxBtn.title = '还原窗口'; }
    } else {
      editSection.style.cssText = editSection.dataset.prevCss || '';
      bodyTextarea.style.cssText = `box-sizing: border-box; display: block; width: 100%; flex: 0 0 auto; min-height: 80px; height: 80px; max-height: 100%; margin: 0; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.6; border: 1px solid #cbd5e1; border-radius: 8px; resize: none; background: #f8fafc; color: #1e293b; overflow-y: hidden;`;
      if (bodyMaxBtn) { bodyMaxBtn.textContent = '⤢'; bodyMaxBtn.title = '最大化编辑'; }
      autoResizeBody();
    }
  };
  if (bodyMaxBtn) bodyMaxBtn.onclick = toggleBodyMax;

  // 左栏放纸张预览，右栏放编辑区
  previewCol.appendChild(contentArea);
  // 页数标签 + 预览页放进一个纵向容器：标签 sticky 在滚动区右上角，负下边距让它不占位
  const previewStack = document.createElement('div');
  previewStack.style.cssText = 'display: flex; flex-direction: column; align-items: center; width: 100%; min-width: 0;';
  const pageCountChip = document.createElement('div');
  pageCountChip.id = 'fj-page-count';
  pageCountChip.style.cssText = 'position: sticky; top: 10px; align-self: flex-end; margin-right: 10px; margin-bottom: -24px; z-index: 20; padding: 2px 6px; border-radius: 2px; font-size: 11px; line-height: 1.5; font-family: system-ui, sans-serif; color: #f1f5f9; background: rgba(100, 116, 139, 0.55); pointer-events: none; white-space: nowrap;';
  previewStack.appendChild(pageCountChip);
  previewStack.appendChild(pagesWrap);
  previewCol.appendChild(previewStack);
  sidebar.appendChild(sideHeader);
  sidebar.appendChild(toolbar);
  sidebar.appendChild(layoutToolbar);
  //sidebar.appendChild(lineHeightToolbar);
  sidebar.appendChild(editSection);

  // 绑定事件
  titleInput.addEventListener('input', () => renderVerticalContent(window.editedText || text, false));
  subtitleInput.addEventListener('input', () => renderVerticalContent(window.editedText || text, false));
  
  const portraitRadio = layoutToolbar.querySelector('input[value="portrait"]');
  const landscapeRadio = layoutToolbar.querySelector('input[value="landscape"]');
  portraitRadio.addEventListener('change', () => {
    if (!portraitRadio.checked) return;
    applyLayoutMode('portrait');
    try { chrome.storage.local.set({ layoutMode: 'portrait' }); } catch (e) {}
  });
  landscapeRadio.addEventListener('change', () => {
    if (!landscapeRadio.checked) return;
    applyLayoutMode('landscape');
    try { chrome.storage.local.set({ layoutMode: 'landscape' }); } catch (e) {}
  });
  
  // 题记相关元素此时还没挂到页面上，绑定放到面板挂载后的 setTimeout 里
  
  const minusBtn = document.getElementById('fj-lineheight-minus');
  const plusBtn = document.getElementById('fj-lineheight-plus');
  const resetBtn = document.getElementById('fj-lineheight-reset');
  if (minusBtn) minusBtn.onclick = () => updateLineHeight(Math.max(1.0, currentLineHeight - 0.1));
  if (plusBtn) plusBtn.onclick = () => updateLineHeight(Math.min(3.0, currentLineHeight + 0.1));
  if (resetBtn) resetBtn.onclick = () => updateLineHeight(2.0);
  
  // 底部按钮栏
  const footer = document.createElement('div');
  footer.className = 'fj-footer fj-card';
  footer.style.cssText = `
    flex: 0 0 auto;
    position: sticky;
    bottom: 0;
    z-index: 6;
    margin-top: auto;
    padding: 10px 12px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    font-size: 12px;
    color: #64748b;
    font-family: system-ui, sans-serif;
    background: #fff;
    box-shadow: 0 -6px 14px rgba(15, 23, 42, 0.08);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
    align-items: center;
  `;
  footer.innerHTML = `
    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; width: 100%;">
      <button id="fj-copy-text" title="复制文本">复制</button>
      <input type="checkbox" id="fj-auto-close" style="width:12px; height:12px; cursor: pointer; margin: 0;"></input><label title="打印/下载后自动关闭">自动关闭</label>
    </div>
    <div style="display: flex; gap: 8px; align-items: center; width: 100%;">
      <button id="fj-print-image" class="fj-btn-primary" style="flex: 1; height: 32px; font-size: 13px;" title="默认为A5尺寸，无页眉页脚">打印</button>
      <button id="fj-download-image" class="fj-btn-primary" style="flex: 1; height: 32px; font-size: 13px;">下载图片</button>
    </div>
  `;
  sidebar.appendChild(footer);
  panel.appendChild(previewCol);
  panel.appendChild(sidebar);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // 读取保存的自动关闭设置
  let autoCloseCheckbox = document.getElementById('fj-auto-close');
  console.log("读取保存的自动关闭设置：", autoCloseCheckbox.checked);
  chrome.storage.sync.get(['autoCloseAfterAction'], (result) => {
    if (autoCloseCheckbox) {
      autoCloseCheckbox.checked = result.autoCloseAfterAction || false;
    }
  });

  // 保存自动关闭设置
  autoCloseCheckbox.addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoCloseAfterAction: e.target.checked });
  });

  // 初始化渲染
  renderVerticalContent(text);

  // 记住仿古纸底纹、版框、页码开关
  try {
    chrome.storage.local.get(['antiquePaper', 'antiqueFrame', 'frameFullPage', 'frameRough', 'pageNumber', 'pageNumberMirror'], (r) => {
      let changed = false;
      const saved = r && r.antiquePaper;
      if (typeof saved === 'boolean' && saved !== currentAntiquePaper) {
        currentAntiquePaper = saved;
        if (antiqueToggle) antiqueToggle.checked = saved;
        changed = true;
      }
      const savedFrame = r && r.antiqueFrame;
      if (typeof savedFrame === 'boolean' && savedFrame !== currentAntiqueFrame) {
        currentAntiqueFrame = savedFrame;
        if (frameToggle) frameToggle.checked = savedFrame;
        renderVerticalContent(window.editedText || text, false);
        changed = true;
      }
      const savedPageNo = r && r.pageNumber;
      if (typeof savedPageNo === 'boolean' && savedPageNo !== currentPageNumber) {
        currentPageNumber = savedPageNo;
        if (pageNumberToggle) pageNumberToggle.checked = savedPageNo;
        changed = true;
      }
      const savedFull = r && r.frameFullPage;
      if (typeof savedFull === 'boolean' && savedFull !== currentFrameFullPage) {
        currentFrameFullPage = savedFull;
        const fullEl = layoutToolbar.querySelector('#fj-frame-fullpage');
        if (fullEl) fullEl.checked = savedFull;
        changed = true;
      }
      const savedRough = r && r.frameRough;
      if (typeof savedRough === 'boolean' && savedRough !== currentFrameRough) {
        currentFrameRough = savedRough;
        const roughEl = layoutToolbar.querySelector('#fj-frame-rough');
        if (roughEl) roughEl.checked = savedRough;
        changed = true;
      }
      const savedMirror = r && r.pageNumberMirror;
      if (typeof savedMirror === 'boolean' && savedMirror !== currentPageNumberMirror) {
        currentPageNumberMirror = savedMirror;
        const mirrorEl = layoutToolbar.querySelector('#fj-page-number-mirror');
        if (mirrorEl) mirrorEl.checked = savedMirror;
        changed = true;
      }
      if (changed) renderPreviewPages();
    });
  } catch (e) {}

  // 记住上次的纸张尺寸
  try {
    chrome.storage.local.get(['paperSize'], (r) => {
      const saved = r && r.paperSize;
      if (!saved || saved === currentPaperSize) return;
      if (saved !== 'A5' && saved !== 'A4') return;
      currentPaperSize = saved;
      const sel = layoutToolbar.querySelector('#fj-paper-size');
      if (sel) sel.value = saved;
      if (saved === 'A5') {
        contentArea.style.width = '148mm';
        contentArea.style.height = '210mm';
      } else {
        contentArea.style.width = '210mm';
        contentArea.style.height = '297mm';
      }
      renderVerticalContent(window.editedText || text, false);
    });
  } catch (e) {}

  // 记住上次的字号
  try {
    chrome.storage.local.get(['fontSize'], (r) => {
      const v = Number(r && r.fontSize);
      if (!v || v < 8 || v > 26 || v === currentFontSize) return;
      currentFontSize = v;
      const span = layoutToolbar.querySelector('#fj-fontsize-val');
      if (span) setFieldValue(span, String(v));
      renderVerticalContent(window.editedText || text, false);
    });
  } catch (e) {}

  // 记住行距、页边距、纸张方向
  try {
    chrome.storage.local.get(['lineHeight', 'marginMm', 'layoutMode', 'gutterMm', 'letterSpacing'], (r) => {
      let changed = false;
      const lh = Number(r && r.lineHeight);
      if (lh && lh >= 1.0 && lh <= 3.0) {
        currentLineHeight = lh;
        const span = layoutToolbar.querySelector('#fj-lineheight-val');
        if (span) setFieldValue(span, lh.toFixed(1));
        changed = true;
      }
      const ls = Number(r && r.letterSpacing);
      if (!isNaN(ls) && ls >= -3 && ls <= 12) {
        currentLetterSpacing = ls;
        const lsSpan = layoutToolbar.querySelector('#fj-letterspacing-val');
        if (lsSpan) setFieldValue(lsSpan, String(ls));
        changed = true;
      }
      const mg = Number(r && r.marginMm);
      if (mg && mg >= 2 && mg <= 30) {
        currentMarginMm = mg;
        const span = layoutToolbar.querySelector('#fj-margin-val');
        if (span) setFieldValue(span, String(mg));
        changed = true;
      }
      const gut = Number(r && r.gutterMm);
      if (!isNaN(gut) && gut >= 0 && gut <= 30) {
        currentGutterMm = gut;
        const gSpan = layoutToolbar.querySelector('#fj-gutter-val');
        if (gSpan) setFieldValue(gSpan, String(gut));
        changed = true;
      }
      const mode = r && r.layoutMode;
      if (mode === 'portrait' || mode === 'landscape') {
        const radio = layoutToolbar.querySelector(`input[name="layout-mode"][value="${mode}"]`);
        if (radio && !radio.checked) {
          radio.checked = true;
          applyLayoutMode(mode);
        }
        changed = true;
      }
      if (changed) renderVerticalContent(window.editedText || text, false);
    });
  } catch (e) {}

  // 记住正文加粗与纯黑
  try {
    chrome.storage.local.get(['bodyBold', 'bodyColor'], (r) => {
      let changed = false;
      if (r && typeof r.bodyBold === 'boolean') {
        currentBold = r.bodyBold;
        const btn = layoutToolbar.querySelector('#fj-bold-toggle');
        if (btn) {
          btn.style.color = currentBold ? '#fff' : '#334155';
          btn.style.background = currentBold ? '#2c3e66' : '#f8fafc';
        }
        changed = true;
      }
      if (r && typeof r.bodyColor === 'string') {
        currentBodyColor = r.bodyColor === '#000000' ? '#000000' : '';
        const btn = layoutToolbar.querySelector('#fj-color-black');
        if (btn) {
          const on = currentBodyColor === '#000000';
          btn.style.color = on ? '#fff' : '#111827';
          btn.style.background = on ? '#2c3e66' : '#f8fafc';
        }
        changed = true;
      }
      if (changed) renderVerticalContent(window.editedText || text, false);
    });
  } catch (e) {}
  
  // 绑定页面上的按钮事件
  setTimeout(() => {
    // 行距按钮
    const minusBtn = document.getElementById('fj-lineheight-minus');
    const plusBtn = document.getElementById('fj-lineheight-plus');
    const resetBtn = document.getElementById('fj-lineheight-reset');
    if (minusBtn) minusBtn.onclick = () => updateLineHeight(Math.max(1.0, currentLineHeight - 0.1));
    if (plusBtn) plusBtn.onclick = () => updateLineHeight(Math.min(3.0, currentLineHeight + 0.1));
    if (resetBtn) resetBtn.onclick = () => updateLineHeight(2.0);

    // 字间距：竖排字与字之间的空隙（px）
    const lsMinus = document.getElementById('fj-letterspacing-minus');
    const lsPlus = document.getElementById('fj-letterspacing-plus');
    const applyLetterSpacing = (val, silent = false) => {
      const v = Math.min(12, Math.max(-3, Math.round(val * 2) / 2));
      currentLetterSpacing = v;
      const span = document.getElementById('fj-letterspacing-val');
      if (span) setFieldValue(span, String(v));
      if (!silent) showToast(v ? `字间距设为 ${v}px` : '字间距恢复默认', 1000);
      try { chrome.storage.local.set({ letterSpacing: v }); } catch (e) {}
      // 字距变了，每列能放的字数也变 → 重新切列
      renderVerticalContent(window.editedText || text, false);
      const epgCount = getEpigraphCount();
      if (epgCount > 0) applyEpigraphFormat();
      schedulePreviewPages();
    };
    if (lsMinus) lsMinus.onclick = () => applyLetterSpacing(currentLetterSpacing - 0.5);
    if (lsPlus) lsPlus.onclick = () => applyLetterSpacing(currentLetterSpacing + 0.5);

    // 题记按钮
    const applyBtn = document.getElementById('fj-apply-epigraph');
    const quick1 = document.getElementById('fj-epigraph-quick-1');
    const quick2 = document.getElementById('fj-epigraph-quick-2');
    const quick3 = document.getElementById('fj-epigraph-quick-3');
    const quick4 = document.getElementById('fj-epigraph-quick-4');
    const quick5 = document.getElementById('fj-epigraph-quick-5');
    const epigraphReset = document.getElementById('fj-epigraph-reset');

    // 题记输入框：只改数值，点「应用」才生效
    const epigraphCountInput = document.getElementById('fj-epigraph-count');
    if (epigraphCountInput) {
      epigraphCountInput.addEventListener('focus', () => {
        if (epigraphCountInput.value === '0') epigraphCountInput.value = '';
      });
      epigraphCountInput.addEventListener('blur', () => {
        if (epigraphCountInput.value.trim() === '') epigraphCountInput.value = '0';
      });
    }
    if (applyBtn) applyBtn.addEventListener('click', applyEpigraphFormat);
    [quick1, quick2, quick3, quick4, quick5].forEach((btn, idx) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (!epigraphCountInput) return;
        epigraphCountInput.value = String(idx + 1);
        // 快捷胶囊直接生效，无需再点“应用”
        applyEpigraphFormat();
      });
    });

    // 重置按钮：清除题记范围
    if (epigraphReset) {
      epigraphReset.addEventListener('click', () => {
        if (epigraphCountInput) {
          epigraphCountInput.value = '0';
          epigraphCountInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const verticalContentDiv = contentArea.querySelector('.vertical-content');
        if (verticalContentDiv) {
          verticalContentDiv.querySelectorAll('.vertical-paragraph').forEach(para => {
            para.classList.remove('epigraph');
          });
        }
        showToast('已清除题记范围', 1000);
      });
    }
    
    // 字号按钮
    const fontMinus = document.getElementById('fj-fontsize-minus');
    const fontPlus = document.getElementById('fj-fontsize-plus');
    const applyFontSize = (val, silent = false) => {
      currentFontSize = val;
      const valSpan = document.getElementById('fj-fontsize-val');
      if (valSpan) setFieldValue(valSpan, String(val));
      if (!silent) showToast(`字号调整为 ${val}pt`, 1000);
      try { chrome.storage.local.set({ fontSize: val }); } catch (e) {}
      // 字号变了，每列能放的字数也变了，必须重新切列排版
      renderVerticalContent(window.editedText || text, false);
      const epgCount = getEpigraphCount();
      if (epgCount > 0) applyEpigraphFormat();
      schedulePreviewPages();
    };
    if (fontMinus) fontMinus.onclick = () => applyFontSize(Math.max(8, currentFontSize - 1));
    if (fontPlus) fontPlus.onclick = () => applyFontSize(Math.min(26, currentFontSize + 1));

    // 页边距
    const marginMinus = document.getElementById('fj-margin-minus');
    const marginPlus = document.getElementById('fj-margin-plus');
    const applyMargin = (val, silent = false) => {
      const v = Math.min(30, Math.max(2, Math.round(val)));
      currentMarginMm = v;
      const span = document.getElementById('fj-margin-val');
      if (span) setFieldValue(span, String(v));
      if (!silent) showToast(`页边距调整为 ${v}mm`, 1000);
      try { chrome.storage.local.set({ marginMm: v }); } catch (e) {}
      // 版心尺寸变了，每列字数要重新计算
      renderVerticalContent(window.editedText || text, false);
      const epgCount = getEpigraphCount();
      if (epgCount > 0) applyEpigraphFormat();
      schedulePreviewPages();
    };
    if (marginMinus) marginMinus.onclick = () => applyMargin(currentMarginMm - 1);
    if (marginPlus) marginPlus.onclick = () => applyMargin(currentMarginMm + 1);

    // 装订线：额外加在内侧的边距
    const gutterMinus = document.getElementById('fj-gutter-minus');
    const gutterPlus = document.getElementById('fj-gutter-plus');
    const applyGutter = (val, silent = false) => {
      const v = Math.min(30, Math.max(0, Math.round(val)));
      currentGutterMm = v;
      const span = document.getElementById('fj-gutter-val');
      if (span) setFieldValue(span, String(v));
      if (!silent) showToast(v ? `装订线设为 ${v}mm` : '已取消装订线', 1000);
      try { chrome.storage.local.set({ gutterMm: v }); } catch (e) {}
      // 装订线占掉版心宽度，列数会变 → 重新排版
      renderVerticalContent(window.editedText || text, false);
      const epgCount = getEpigraphCount();
      if (epgCount > 0) applyEpigraphFormat();
      schedulePreviewPages();
    };
    if (gutterMinus) gutterMinus.onclick = () => applyGutter(currentGutterMm - 1);
    if (gutterPlus) gutterPlus.onclick = () => applyGutter(currentGutterMm + 1);

    // 版面数值框支持直接填写：回车或失焦时生效，非法输入回退到当前值
    const bindNumField = (id, handler) => {
      const el = document.getElementById(id);
      if (!el) return;
      const commit = () => {
        const raw = String(el.value || '').replace(/[^\d.\-]/g, '');
        const v = Number(raw);
        if (raw === '' || isNaN(v)) { handler(null); return; }
        handler(v);
      };
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); el.blur(); }
      });
      el.addEventListener('blur', commit);
      el.addEventListener('mousedown', (e) => e.stopPropagation());
    };
    bindNumField('fj-fontsize-val', (v) => {
      const el = document.getElementById('fj-fontsize-val');
      if (v == null) { setFieldValue(el, String(currentFontSize)); return; }
      applyFontSize(Math.min(26, Math.max(8, Math.round(v))));
    });
    bindNumField('fj-margin-val', (v) => {
      if (v == null) { setFieldValue(document.getElementById('fj-margin-val'), String(currentMarginMm)); return; }
      applyMargin(v);
    });
    bindNumField('fj-gutter-val', (v) => {
      if (v == null) { setFieldValue(document.getElementById('fj-gutter-val'), String(currentGutterMm)); return; }
      applyGutter(v);
    });
    bindNumField('fj-letterspacing-val', (v) => {
      if (v == null) { setFieldValue(document.getElementById('fj-letterspacing-val'), String(currentLetterSpacing)); return; }
      applyLetterSpacing(v);
    });
    bindNumField('fj-lineheight-val', (v) => {
      if (v == null) { setFieldValue(document.getElementById('fj-lineheight-val'), currentLineHeight.toFixed(1)); return; }
      updateLineHeight(Math.min(3, Math.max(1, v)));
    });

    // 正文加粗开关
    const boldToggle = document.getElementById('fj-bold-toggle');
    if (boldToggle) {
      boldToggle.onclick = () => {
        currentBold = !currentBold;
        boldToggle.style.background = currentBold ? '#2c3e66' : '#f8fafc';
        boldToggle.style.color = currentBold ? '#fff' : '#334155';
        renderVerticalContent(window.editedText || text, false);
        const epgCount = getEpigraphCount();
        if (epgCount > 0) applyEpigraphFormat();
        schedulePreviewPages();
        showToast(currentBold ? '正文已加粗' : '正文已恢复正常字重', 1000);
        try { chrome.storage.local.set({ bodyBold: currentBold }); } catch (e) {}
      };
    }

    // 正文纯黑
    const colorBlackBtn = document.getElementById('fj-color-black');
    if (colorBlackBtn) {
      colorBlackBtn.onclick = () => {
        const on = currentBodyColor === '#000000';
        currentBodyColor = on ? '' : '#000000';
        colorBlackBtn.style.color = on ? '#111827' : '#fff';
        colorBlackBtn.style.background = on ? '#f8fafc' : '#2c3e66';
        renderVerticalContent(window.editedText || text, false);
        const epgCount = getEpigraphCount();
        if (epgCount > 0) applyEpigraphFormat();
        schedulePreviewPages();
        showToast(on ? '正文颜色已恢复' : '正文已改为纯黑', 1000);
        try { chrome.storage.local.set({ bodyColor: currentBodyColor }); } catch (e) {}
      };
    }

    // 页边距快捷：窄 5mm / 中 8mm / 宽 14mm
    const marginNarrow = document.getElementById('fj-margin-quick-narrow');
    const marginMid = document.getElementById('fj-margin-quick-mid');
    const marginWide = document.getElementById('fj-margin-quick-wide');
    if (marginNarrow) marginNarrow.onclick = () => applyMargin(5);
    if (marginMid) marginMid.onclick = () => applyMargin(8);
    if (marginWide) marginWide.onclick = () => applyMargin(14);

    // 字体
    const fontFamilyInput = document.getElementById('fj-font-family');
    // 输入框里显示 display 名（中文），应用时再按 family 走
    const resolveFontFamilyName = (text) => {
      const v = String(text || '').trim();
      if (!v) return v;
      if (fontOptions.includes(v)) return v;
      const byDisplay = fontOptions.find(n => fontDisplayName(n) === v);
      if (byDisplay) return byDisplay;
      const byAlias = fontOptions.find(n => (fontAliases[n] || []).some(a => a === v || stripFontStyle(a) === v));
      return byAlias || v;
    };

    const applyFontFamily = (name, silent = false) => {
      const v = String(name || '').trim() || '方正金陵';
      currentFontFamily = v;
      if (fontFamilyInput) fontFamilyInput.value = fontDisplayName(v);
      if (v && !fontOptions.includes(v)) {
        fontOptions = sortFontOptions(fontOptions.concat([v]));
      }
      contentArea.querySelectorAll('.vertical-paragraph').forEach(para => {
        para.style.fontFamily = `'${v}', 'FZJinL-B_GBJF', '华文楷书', 'KaiTi', '宋体', serif`;
      });
      if (!silent) showToast(`字体已切换为 ${v}`, 1200);
      // 字体变了，字宽也变，每列字数需要重算
      renderVerticalContent(window.editedText || text, false);
      const epgCount = getEpigraphCount();
      if (epgCount > 0) applyEpigraphFormat();
      schedulePreviewPages();
      try { chrome.storage.local.set({ fontFamily: v }); } catch (e) {}
      if (!silent) rememberFont(v);
    };
    // 新标签页：全部字体的完整元数据页（扩展页，带“使用”按钮回传）
    const openFontMetaTab = () => {
      const openPage = () => {
        // 交给后台 chrome.tabs.create：网页里直接 open 扩展 URL 会被拦（ERR_BLOCKED_BY_CLIENT）
        chrome.runtime.sendMessage({ action: 'OPEN_FONT_PAGE' }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.success) {
            showToast('打开全部字体页失败，请重试', 2000);
          }
        });
      };
      // 把这次读到的真实元数据快照写进存储，页面优先用它（内容脚本所在页面的名字本地化才是中文）
      const writeSnapshot = (cb) => {
        try {
          chrome.storage.local.set({
            fontPageSnapshot: {
              faces: fontFaces,
              at: Date.now(),
              // 帮全部字体页按同样的逻辑分组排序（系统中文 → 厂商 → 其它 → 自带西文字体）
              tier1: TIER1_FONTS,
              foundries: FOUNDRY_PREFIXES,
              latin: LATIN_BUNDLED_FONTS
            }
          }, () => cb());
        } catch (e) { cb(); }
      };
      if (fontFaces.length) { writeSnapshot(openPage); return; }
      // 缓存里没有元数据（旧缓存）：先实读一次并落盘，等写入完成再开页面
      let done = false;
      const finish = (delay) => { if (done) return; done = true; setTimeout(() => writeSnapshot(openPage), delay); };
      try {
        queryLocalFontsDirect().then((list) => {
          if (list && list.length) { mergeFonts(list); finish(120); } else finish(0);
        }).catch(() => finish(0));
      } catch (e) {
        finish(0);
      }
      setTimeout(() => finish(0), 1500);   // 兜底：读不出来也照样打开页面
    };
    if (fontFamilyInput) {
      bindLocalFontMessages();
      const fontPanel = document.getElementById('fj-font-panel');
      const fontToggle = document.getElementById('fj-font-toggle');
      // 已有磁盘缓存/已读到全量时不要覆盖，否则搜索又只剩探测出的几十个
      if (!fontOptions.length) {
        const detected = detectLocalFonts();
        fontOptions = sortFontOptions(detected.length ? detected : FONT_CANDIDATES.slice());
      }

      // 浮层挂到 body，避免被右栏 overflow 裁掉
      if (fontPanel) {
        fontPanel.style.position = 'fixed';
        fontPanel.style.marginTop = '0';
        document.body.appendChild(fontPanel);
      }

      const positionFontPanel = () => {
        if (!fontPanel) return;
        const r = fontFamilyInput.getBoundingClientRect();
        fontPanel.style.left = r.left + 'px';
        fontPanel.style.top = (r.bottom + 3) + 'px';
        // 用户手动拖拽拉大过的话，不再覆盖尺寸
        if (fontPanel.dataset.userSized === '1') return;
        // 宽度覆盖到刷新按钮右边缘，比输入框更宽一些
        const refreshBtn = document.getElementById('fj-font-refresh');
        const rightEdge = refreshBtn ? refreshBtn.getBoundingClientRect().right : r.right;
        fontPanel.style.width = Math.max(r.width, rightEdge - r.left) + 'px';
      };

      let fontPrevValue = null;   // 下拉打开前的输入框内容
      let fontPicked = false;     // 本次下拉是否真正选了字体
      let fontQuery = '';         // 当前搜索词（缩放/字体补全重绘时不能把它丢掉）

      // 悬浮字体预览时弹出 3 倍放大的浮层
      let fontPreviewTip = null;
      let fontPreviewHideTimer = null;
      const hideFontPreview = () => {
        if (fontPreviewHideTimer) { clearTimeout(fontPreviewHideTimer); fontPreviewHideTimer = null; }
        if (fontPreviewTip) fontPreviewTip.style.display = 'none';
      };
      // 鼠标从字体行移开时留一点缓冲，不要立刻消失
      const scheduleFontPreviewHide = () => {
        if (fontPreviewHideTimer) clearTimeout(fontPreviewHideTimer);
        fontPreviewHideTimer = setTimeout(() => { fontPreviewHideTimer = null; hideFontPreview(); }, 700);
      };

      // 浮层显示时按 C 截图；即使焦点还在字体输入框，也拦下这一个 c，不把它打进输入框
      document.addEventListener('keydown', (ev) => {
        if (!fontPreviewTip || fontPreviewTip.style.display === 'none') return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (String(ev.key || '').toLowerCase() !== 'c') return;
        const t = ev.target;
        const tag = (t && t.tagName || '').toLowerCase();
        // 正文编辑区（textarea / contenteditable）里的 c 仍然当普通输入
        if (tag === 'textarea' || (t && t.isContentEditable)) return;
        const sampleEl = fontPreviewTip.querySelector('.fj-tip-sample');
        const sampleText = sampleEl ? sampleEl.textContent : '';
        const size = sampleEl ? (parseFloat(sampleEl.style.fontSize) || 0) : 0;
        const fam = fontPreviewTip.dataset.family || '';
        const full = fontPreviewTip.dataset.full || '';
        if (!sampleText || !fam || !size) return;
        ev.preventDefault();
        ev.stopPropagation();
        captureFontPreview(sampleText, fam, full, size);
      });


      const captureFontPreview = (sampleText, familyName, fullName, size) => {
        const padX = 18;
        const padY = 14;
        const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
        const metaFont = '11px system-ui, sans-serif';
        const metaText = (fullName && fullName !== familyName) ? familyName + '　·　' + fullName : familyName;
        const meas = document.createElement('canvas').getContext('2d');
        meas.font = size + 'px "' + familyName + '", serif';
        const sampleW = Math.ceil(meas.measureText(sampleText).width);
        meas.font = metaFont;
        const metaW = Math.ceil(meas.measureText(metaText).width);
        const W = Math.max(sampleW, metaW, 120) + padX * 2 + 2;
        const sampleH = Math.ceil(size * 1.35);
        const metaH = Math.ceil(11 * 1.35);
        const H = padY * 2 + sampleH + 6 + metaH + 2;
        const cv = document.createElement('canvas');
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#fffdf7';
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(0.5, 0.5, W - 1, H - 1);
        ctx.fill();
        ctx.stroke();
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#1e293b';
        ctx.font = size + 'px "' + familyName + '", serif';
        ctx.fillText(sampleText, padX, padY);
        ctx.fillStyle = '#94a3b8';
        ctx.font = metaFont;
        ctx.fillText(metaText, padX, padY + sampleH + 6);
        // 截图时不把右下角提示画进去
        cv.toBlob((blob) => {
          if (!blob) { showToast('截图失败', 1400); return; }
          const fallbackDownload = () => {
            try {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'font-preview.png';
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              showToast('剪贴板不可用，已下载图片', 1600);
            } catch (e) { showToast('截图失败', 1400); }
          };
          if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
              .then(() => showToast('浮层截图已复制到剪贴板', 1400))
              .catch(fallbackDownload);
          } else {
            fallbackDownload();
          }
        }, 'image/png');
      };
      const showFontPreview = (name, sample, anchorEl) => {
        // 取消上一行留下的延时隐藏，否则换行/重绘时会被旧计时器关掉
        if (fontPreviewHideTimer) { clearTimeout(fontPreviewHideTimer); fontPreviewHideTimer = null; }
        if (!fontPreviewTip) {
          fontPreviewTip = document.createElement('div');
          fontPreviewTip.style.cssText = 'position: fixed; z-index: 2147483000; pointer-events: none; display: none; max-width: calc(100vw - 16px); box-sizing: border-box; background: #fffdf7; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18); padding: 14px 18px;';
          document.body.appendChild(fontPreviewTip);
        }
        const baseSize = Math.round(17 * fontPanelScale * 3);   // 3 倍预览
        const cssFont = `'${String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', serif`;
        // 浮层底下两行元信息：family 名（=下拉里的名字）+ fullName（有且不同时才显示）
        const metaLine = 'margin-top: 6px; display: flex; align-items: baseline; gap: 8px; font-family: system-ui, sans-serif; font-size: 11px; color: #94a3b8; white-space: nowrap;';
        const familyName = String(name || '');
        const fullNames = (fontAliases && fontAliases[familyName]) || [];
        const fullName = String(fullNames[0] || '');
        const fullLine = (fullName && fullName !== familyName)
          ? `　·　${escapeHtml(fullName)}`
          : '';
        // 提示文字跟第二行同一基线、右边缘与左内边距（18px）对齐
        const hintHtml = '<span class="fj-tip-hint" style="margin-left: auto; flex: 0 0 auto; font-size: 10px; color: #64748b; letter-spacing: .5px; pointer-events: none;">按 C 截图</span>';
        fontPreviewTip.innerHTML = `<div class="fj-tip-sample" style="font-family: ${cssFont}; font-size: ${baseSize}px; line-height: 1.35; color: #1e293b; white-space: nowrap;">${escapeHtml(sample)}</div><div style="${metaLine}"><span style="flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(familyName)}${fullLine}</span>${hintHtml}</div>`;
        // 记住当前浮层用的数据，按 C 时取
        fontPreviewTip.dataset.family = familyName;
        fontPreviewTip.dataset.full = fullName;
        fontPreviewTip.style.left = '0px';
        fontPreviewTip.style.top = '-9999px';
        fontPreviewTip.style.display = 'block';
        const r = anchorEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // 字多时最多左移两个字：先按这个左边界算可用宽度，再缩字号把整句装进去
        const maxShift = baseSize * 2;
        const targetLeft = Math.max(8, r.left - maxShift);
        const avail = vw - 8 - targetLeft - 36;   // 右侧 8px 余量 + 浮层内边距
        const sampleEl = fontPreviewTip.querySelector('.fj-tip-sample');
        let size = baseSize;
        // 反复校准：字体宽度估不准时可能一次缩不够
        for (let i = 0; i < 3; i++) {
          const natural = sampleEl ? sampleEl.scrollWidth : 0;
          if (!natural || natural <= avail) break;
          size = Math.max(14, Math.floor(size * (avail / natural)));
          sampleEl.style.fontSize = size + 'px';
        }
        const w = fontPreviewTip.offsetWidth;
        const h = fontPreviewTip.offsetHeight;
        // 需要缩字号（或本来就放不下）时，才按“两个字”的量往左让；否则保持对齐行首
        const needShift = w > (vw - 8 - r.left - 36);
        let left = needShift ? targetLeft : r.left;
        if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
        // 优先显示在行的下方，下面放不下就翻到上方，再不行贴住行
        let top = r.bottom + 8;
        if (top + h > vh - 8) top = r.top - h - 8;
        if (top < 8) top = Math.max(8, Math.min(vh - h - 8, r.top));
        fontPreviewTip.style.left = left + 'px';
        fontPreviewTip.style.top = top + 'px';
      };

      // 放大预览用的例句：取正文开头最多 16 字；若已包含一个以上的句读，
      // 且最后一个句子被截断，就把这半句舍掉，只留完整的句子
      const previewSample = () => {
        const src = String((typeof window.editedText !== 'undefined' && window.editedText) || text || '')
          .replace(/[\s\u3000]+/g, '');
        if (!src) return fontSampleLine;
        const LIMIT = 16;
        let s = src.slice(0, LIMIT);
        if (src.length > LIMIT) {
          // 找到 s 里最后一个句读符号（，。；、：！？ 及半角）
          const punct = /[，。；、：！？,.;:!?]/g;
          let lastIdx = -1;
          let m;
          while ((m = punct.exec(s)) !== null) lastIdx = m.index;
          // 只有前面至少还有一个句读（即截到了一句以上）才舍弃半句
          if (lastIdx > 0 && lastIdx < s.length - 1) {
            const earlier = s.slice(0, lastIdx).search(/[，。；、：！？,.;:!?]/);
            if (earlier >= 0) s = s.slice(0, lastIdx + 1);
          }
        }
        return s || fontSampleLine;
      };

      const closeFontPanel = () => {
        hideFontPreview();
        if (fontPanel) fontPanel.style.display = 'none';
        // 没选字体就把原值恢复回输入框
        if (!fontPicked && fontPrevValue !== null) {
          fontFamilyInput.value = fontPrevValue;
        }
        fontPrevValue = null;
        fontPicked = false;
        syncFontClear();
      };

      const renderFontPanel = (filter, useFilter) => {
        if (!fontPanel) return;
        hideFontPreview();
        const q = useFilter ? String(filter || '').trim().toLowerCase() : '';
        // 归一化搜索词与字体名：忽略空格/连字符/下划线/中点，"qiji" 也能命中 "QIJI-Sans SC"
        const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_·・.]+/g, '');
        const qn = norm(q);
        const matchName = (n) => {
          if (!q) return true;
          const names = [n].concat(fontAliases[n] || []);
          for (const name of names) {
            if (String(name).toLowerCase().includes(q)) return true;
            if (qn && norm(name).includes(qn)) return true;
          }
          return false;
        };
        fontQuery = q;   // 记住当前搜索，后续缩放/字体补全重绘要沿用
        // 只在“已生效的字体”没被探测到时才补进列表；
        // 不能用输入框内容（那是搜索词，输入 boya 就会凭空多出一条叫 boya 的字体）
        const current = String(currentFontFamily || '').trim();
        let baseList = fontOptions.slice();
        if (current && !baseList.includes(current)) baseList.unshift(current);
        // 分组顺序：收藏 → 最近使用 → 全部
        const favList = favoriteFonts.filter(n => matchName(n));
        const recent = recentFonts.filter(n => !favList.includes(n) && matchName(n));
        // “英文字体”未勾选时，Windows 自带西文字体不在“全部字体”和搜索结果里出现
        // （收藏 / 最近使用仍照常显示，用户自己挑过的不会被藏起来）
        const visibleInAll = (n) => !(showWindowsEnFonts === false && isWindowsEnFont(n));
        let groups;
        if (q) {
          const others = baseList.filter(n => !favList.includes(n) && !recent.includes(n) && matchName(n) && visibleInAll(n));
          groups = [{ label: '', list: favList.concat(recent, others) }];
        } else {
          const others = baseList.filter(n => !favList.includes(n) && !recent.includes(n) && visibleInAll(n));
          groups = [
            { label: '收藏', list: favList, keep: true },
            { label: '最近使用', list: recent },
            { label: '全部字体', list: others, withEnToggle: true }
          ].filter(g => g.list.length || g.withEnToggle || g.keep);
        }
        const s = fontPanelScale;              // 下拉被拉大时文字同步放大
        const fSample = (17 * s).toFixed(1);   // 预览字放大一点，行高仍按原来的固定像素，不撑高行
        const fName = (10 * s).toFixed(1);
        const fHead = (10 * s).toFixed(1);
        const fDel = (11 * s).toFixed(1);
        const fStar = (12 * s).toFixed(1);
        const padX = (10 * s).toFixed(1);
        const padY = (5 * s).toFixed(1);
        const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

        // 扁平化成条目：分组标题 + 字体项，滚动到底再追加渲染（几百个字体也不卡）
        const entries = [];
        groups.forEach((g) => {
          if (g.label) entries.push({ type: 'head', label: g.label, withEnToggle: !!g.withEnToggle });
          g.list.forEach(n => entries.push({ type: 'font', name: n }));
        });
        // 「全部字体」页入口挂在第一个分组标题上（通常是“收藏”那一行最右）
        const firstHead = entries.find(e => e.type === 'head');
        if (firstHead) firstHead.withAllLink = true;
        if (!entries.some(e => e.type === 'font') && !entries.some(e => e.type === 'head')) {
          if (!q) { closeFontPanel(); return; }
          // 搜不到时只显示提示，不要关掉面板（否则会把正在输入的搜索词一起清掉）
          fontPanel.innerHTML = `<div style="padding: 12px 10px; color: #94a3b8; font-size: 12px;">没有匹配「${q.replace(/&/g, '&amp;').replace(/</g, '&lt;')}」的字体</div>`;
          positionFontPanel();
          fontPanel.style.display = 'block';
          return;
        }

        const headHtml = (label, withEnToggle, withAllLink) => {
          const enToggle = withEnToggle
            ? `<label class="fj-en-toggle" title="显示 Windows 自带的西文字体" style="display: flex; align-items: center; gap: 4px; flex: 0 0 auto; cursor: pointer; color: #64748b; font-size: ${fHead}px;"><input type="checkbox" class="fj-en-chk"${showWindowsEnFonts ? ' checked' : ''} style="width: ${(11 * s).toFixed(1)}px; height: ${(11 * s).toFixed(1)}px; margin: 0; cursor: pointer;">英文字体</label>`
            : '';
          const allLink = withAllLink
            ? `<span class="fj-font-all" title="在新标签页查看全部字体的完整元数据" style="flex: 0 0 auto; color: #2563eb; font-size: ${fHead}px; cursor: pointer; text-decoration: underline;">全部字体</span>`
            : '';
          return `<div style="padding: ${(4 * s).toFixed(1)}px ${padX}px ${(3 * s).toFixed(1)}px; font-size: ${fHead}px; color: #94a3b8; background: #f8fafc; border-top: 1px solid #eef2f7; border-bottom: 1px solid #eef2f7; display: flex; align-items: center; justify-content: space-between; gap: 8px;"><span>${label}</span><span style="display: flex; align-items: center; gap: 10px;">${allLink}${enToggle}</span></div>`;
        };
        const itemHtml = (n) => {
          const cssName = "'" + String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
          const disp = fontDisplayName(n);
          const isFav = favoriteFonts.includes(n);
          const isRecent = recentFonts.includes(n);
          const star = `<span class="fj-fav" data-font="${esc(n)}" title="${isFav ? '取消收藏' : '收藏'}" style="flex: 0 0 auto; padding: 0 4px; font-size: ${fStar}px; line-height: 1; cursor: pointer; color: ${isFav ? '#d97706' : '#94a3b8'}; display: ${isFav ? 'inline-block' : 'none'};">${isFav ? '★' : '☆'}</span>`;
          const delBtn = isRecent
            ? `<span class="fj-recent-del" data-font="${esc(n)}" title="从最近使用中移除" style="flex: 0 0 auto; padding: 0 4px; color: #94a3b8; font-size: ${fDel}px; cursor: pointer;">✕</span>`
            : '';
          return `<div class="fj-font-item" data-font="${esc(n)}" style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: ${padY}px ${padX}px; cursor: pointer; white-space: nowrap; overflow: hidden;">
            <span style="flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px;">
              <span class="fj-font-sample" data-font="${esc(n)}" style="flex: 0 0 auto; font-family: ${cssName}; font-size: ${fSample}px; line-height: ${(19.5 * s).toFixed(1)}px; color: #1e293b; white-space: nowrap;">${fontSampleLine}</span>
              <span title="${esc(n)}" style="flex: 1 1 auto; min-width: 0; font-family: system-ui, sans-serif; font-size: ${fName}px; line-height: 1.3; color: #94a3b8; white-space: nowrap; overflow: hidden;">${esc(disp)}</span>
            </span>${star}${delBtn}</div>`;
        };

        const bindChunk = (root) => {
          root.querySelectorAll('.fj-font-item').forEach(el => {
            el.addEventListener('mouseenter', () => {
              el.style.background = '#eef2f7';
              // 收藏图标只在悬浮时占位显示，平时把位置让给字体名称
              el.querySelectorAll('.fj-fav').forEach(f => { f.style.display = 'inline-block'; });
            });            el.addEventListener('mouseleave', () => {
              el.style.background = '';
              el.querySelectorAll('.fj-fav').forEach(f => {
                if (!favoriteFonts.includes(f.dataset.font)) f.style.display = 'none';
              });
            });
            el.addEventListener('mousedown', (ev) => {
              ev.preventDefault();
              if (ev.target && ev.target.classList && (ev.target.classList.contains('fj-recent-del') || ev.target.classList.contains('fj-fav'))) return;
              const name = el.dataset.font;
              fontPicked = true;
              fontFamilyInput.value = name;
              applyFontFamily(name);
              closeFontPanel();
            });
          });
          // 悬浮字体预览：右侧弹一个 3 倍放大的浮层
          root.querySelectorAll('.fj-font-sample').forEach(sp => {
            sp.addEventListener('mouseenter', () => showFontPreview(sp.dataset.font, previewSample(), sp));
            sp.addEventListener('mouseleave', scheduleFontPreviewHide);
            sp.addEventListener('mousedown', hideFontPreview);
          });
          // 收藏星标：切换收藏状态。只在原地更新星号，不重绘列表——避免刚收藏的字体立刻跳到「收藏」组最上面
          root.querySelectorAll('.fj-fav').forEach(btn => {
            btn.addEventListener('mousedown', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const name = btn.dataset.font;
              const nowFav = !favoriteFonts.includes(name);
              if (!nowFav) {
                favoriteFonts = favoriteFonts.filter(n => n !== name);
              } else {
                favoriteFonts = [name].concat(favoriteFonts.filter(n => n !== name)).slice(0, 30);
              }
              try { chrome.storage.local.set({ favoriteFonts }); } catch (e) {}
              btn.textContent = nowFav ? '★' : '☆';
              btn.style.color = nowFav ? '#d97706' : '#94a3b8';
              btn.style.display = 'inline-block';
              btn.title = nowFav ? '取消收藏' : '收藏';
              showToast(nowFav ? '已收藏（下次打开下拉置顶）' : '已取消收藏', 1200);
            });
          });
          // 最近使用项右侧叉号：仅从“最近使用”里移除，不影响当前字体
          root.querySelectorAll('.fj-recent-del').forEach(btn => {
            btn.addEventListener('mousedown', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const name = btn.dataset.font;
              recentFonts = recentFonts.filter(n => n !== name);
              try { chrome.storage.local.set({ recentFonts }); } catch (e) {}
              renderFontPanel(q, !!q);
            });
          });
          // “全部字体”行末的英文字体开关：勾选后 Windows 自带西文字体才参与显示
          root.querySelectorAll('.fj-en-chk').forEach(chk => {
            chk.addEventListener('change', (ev) => {
              ev.stopPropagation();
              showWindowsEnFonts = !!chk.checked;
              try { chrome.storage.local.set({ showWindowsEnFonts }); } catch (e) {}
              renderFontPanel(q, !!q);
            });
            chk.addEventListener('mousedown', (ev) => ev.stopPropagation());
          });
          // 表头「全部字体」链接：另开标签页看全量元数据（带“使用”按钮）
          root.querySelectorAll('.fj-font-all').forEach(link => {
            link.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              openFontMetaTab();
            });
            link.addEventListener('mousedown', (ev) => ev.stopPropagation());
          });
        };

        let renderedCount = 0;
        const CHUNK = 60;
        const renderMore = () => {
          if (renderedCount >= entries.length) return;
          const chunk = entries.slice(renderedCount, renderedCount + CHUNK);
          renderedCount += chunk.length;
          const tmp = document.createElement('div');
          tmp.innerHTML = chunk.map(e => e.type === 'head' ? headHtml(e.label, e.withEnToggle, e.withAllLink) : itemHtml(e.name)).join('');
          bindChunk(tmp);
          while (tmp.firstChild) fontPanel.appendChild(tmp.firstChild);
          // 一屏还没填满就继续追加
          if (renderedCount < entries.length && fontPanel.clientHeight > 0 && fontPanel.scrollHeight <= fontPanel.clientHeight) {
            renderMore();
          }
        };

        fontPanel.innerHTML = '';
        // 搜索时若本机全量字体还没读完，先提示，读完后会自动按当前搜索词重绘
        if (q && !fullFontListLoaded) {
          const note = document.createElement('div');
          note.style.cssText = 'padding: 7px 10px; color: #b45309; background: #fffbeb; border-bottom: 1px solid #fde68a; font-size: 11px;';
          note.textContent = '正在读取本机全部字体，结果可能还会补全…';
          fontPanel.appendChild(note);
        }
        fontPanel.scrollTop = 0;
        positionFontPanel();
        fontPanel.style.display = 'block';
        renderMore();
        fontPanel.onscroll = () => {
          hideFontPreview();
          if (fontPanel.scrollTop + fontPanel.clientHeight >= fontPanel.scrollHeight - 240) renderMore();
        };
      };

      // 下拉可拖拽放大：宽度变大时，内部示例文字等比放大
      let fontPanelBaseW = 0;
      const syncPanelScale = () => {
        if (!fontPanel || fontPanel.style.display !== 'block') return;
        const w = fontPanel.clientWidth;
        if (!w) return;
        if (!fontPanelBaseW) fontPanelBaseW = w;
        const next = Math.max(1, Math.min(2.6, w / fontPanelBaseW));
        if (next > 1.02) fontPanel.dataset.userSized = '1';
        if (Math.abs(next - fontPanelScale) > 0.04) {
          fontPanelScale = next;
          // 保留当前搜索词：否则一拉大/一滚动搜索就被重置成完整列表
          renderFontPanel(fontQuery, !!fontQuery);
        }
      };
      try { new ResizeObserver(syncPanelScale).observe(fontPanel); } catch (e) {}

      // 字体列表异步补全（本机字体读取完成后）：若下拉正开着，沿用当前搜索词重绘
      document.addEventListener('fj-fonts-updated', () => {
        if (fontPanel && fontPanel.style.display === 'block') renderFontPanel(fontQuery, !!fontQuery);
      });

      const openFontPanel = () => {
        // 打开时清空输入框，先展示全量列表（避免第一次只看到当前字体的匹配项）
        if (fontPanel && fontPanel.style.display !== 'block') {
          const cur = String(fontFamilyInput.value || '').trim();
          fontPrevValue = cur || '';
          fontPicked = false;
          if (cur) fontFamilyInput.value = '';
          // 每次打开换一句《千字文》做示例
          fontSampleLine = QIANZIWEN_LINES[Math.floor(Math.random() * QIANZIWEN_LINES.length)];
          // 恢复默认尺寸
          delete fontPanel.dataset.userSized;
          fontPanel.style.width = '';
          fontPanel.style.height = '';
          fontPanelScale = 1;
          fontPanelBaseW = 0;
          syncFontClear();
        }
        // 先用现有列表立刻展开，避免第一次点击只有一项
        const had = fontOptions.length;
        if (!had) {
          const detected = detectLocalFonts();
          if (detected && detected.length) fontOptions = sortFontOptions(detected);
        }
        renderFontPanel('', false);
        requestLocalFonts();
        if (!had) setTimeout(() => {
          if (fontPanel && fontPanel.style.display === 'block') renderFontPanel('', false);
        }, 150);
      };

      fontFamilyInput.addEventListener('focus', () => { openFontPanel(); });
      fontFamilyInput.addEventListener('input', () => {
        syncFontClear();
        // 搜索要在“本机全部字体”里进行：还没读完就顺手触发一次读取
        if (!fullFontListLoaded) requestLocalFonts();
        renderFontPanel(fontFamilyInput.value, true);
      });
      // 输入框内置清空按钮
      const fontClear = document.getElementById('fj-font-clear');
      function syncFontClear() {
        if (!fontClear) return;
        fontClear.style.display = String(fontFamilyInput.value || '').trim() ? 'flex' : 'none';
      }
      syncFontClear();
      if (fontClear) {
        fontClear.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          fontFamilyInput.value = '';
          fontPrevValue = '';
          syncFontClear();
          fontFamilyInput.focus();
          renderFontPanel('', false);
        });
      }
      fontFamilyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (String(fontFamilyInput.value || '').trim()) {
            fontPicked = true;
            // 输入框可能是显示名（中文），先解析回真实 family
            applyFontFamily(resolveFontFamilyName(fontFamilyInput.value));
          }
          closeFontPanel();
        }
        if (e.key === 'Escape') closeFontPanel();
      });
      if (fontToggle) {
        fontToggle.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          // 再点箭头就收起（打开状态 → 关闭）
          if (fontPanel && fontPanel.style.display === 'block') {
            closeFontPanel();
            return;
          }
          fontFamilyInput.focus();
          openFontPanel();
        });
      }
      // 记住上次选择的字体 + 最近使用过的字体
      // 新标签页里点「使用」后回传所选字体：全局只绑一次，由当前打开的面板接收
      window.__fjPickFont = (name) => {
        const v = String(name || '').trim();
        if (!v) return;
        fontPicked = true;
        if (fontFamilyInput) fontFamilyInput.value = v;
        applyFontFamily(v);
        try { closeFontPanel(); } catch (e) {}
        showToast(`已应用字体：${fontDisplayName(v)}`, 1500);
      };
      if (!window.__fjPickBound) {
        window.__fjPickBound = true;
        window.addEventListener('message', (ev) => {
          if (!ev.data || ev.data.type !== 'FJ_FONT_PICK') return;
          if (typeof window.__fjPickFont === 'function') window.__fjPickFont(ev.data.name);
        });
        // “全部字体”页由后台新建标签页打开，没有 opener，靠 storage 变更回传
        try {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.fontFamily) return;
            const v = String(changes.fontFamily.newValue || '').trim();
            if (!v) return;
            if (v === String(currentFontFamily || '').trim()) return;
            if (typeof window.__fjPickFont === 'function') window.__fjPickFont(v);
          });
        } catch (e) {}
      }
      try {
        chrome.storage.local.get(['fontFamily', 'recentFonts', 'favoriteFonts', 'showWindowsEnFonts'], (r) => {
          if (r && Array.isArray(r.recentFonts)) recentFonts = r.recentFonts.slice(0, 8);
          if (r && Array.isArray(r.favoriteFonts)) favoriteFonts = r.favoriteFonts.slice(0, 30);
          if (r && typeof r.showWindowsEnFonts === 'boolean') showWindowsEnFonts = r.showWindowsEnFonts;
          const saved = r && r.fontFamily;
          if (saved) {
            fontFamilyInput.value = saved;
            applyFontFamily(saved, true);
          }
        });
      } catch (e) {}
      // 点击字体下拉之外的任何位置都收起下拉（捕获阶段，避免被其它 handler 拦掉）
      const onDocumentDown = (ev) => {
        if (!fontPanel || fontPanel.style.display !== 'block') return;
        if (fontPanel.contains(ev.target)) return;
        if (ev.target === fontFamilyInput || (fontToggle && fontToggle.contains(ev.target))) return;
        closeFontPanel();
      };
      window.addEventListener('mousedown', onDocumentDown, true);
      window.addEventListener('pointerdown', onDocumentDown, true);
      window.addEventListener('resize', positionFontPanel);
      document.addEventListener('fj-fonts-updated', () => {
        if (fontPanel && fontPanel.style.display === 'block') renderFontPanel(fontFamilyInput.value, true);
      });

      const fontRefreshBtn = document.getElementById('fj-font-refresh');
      if (fontRefreshBtn) {
        fontRefreshBtn.onclick = () => {
          localFontsRequested = true;
          fontRefreshDone = false;       // 手动刷新：允许重新实读一次
          showToast('正在重新读取系统字体…', 1200);
          refreshFontList((count, source) => {
            if (count > 0) {
              showToast(`已读取 ${count} 个字体`, 1600);
            } else if (source === 'probe') {
              showToast('已发起读取，列表刷新后会自动补全', 2000);
            } else {
              showToast('未获得字体授权，沿用已缓存的字体列表', 2000);
            }
            renderFontPanel(fontQuery, !!fontQuery);
          });
        };
      }
    }

    // 版面重置：纸张、方向、字号、行距全部恢复默认
    const layoutResetBtn = document.getElementById('fj-layout-reset');
    if (layoutResetBtn) {
      layoutResetBtn.onclick = () => {
        const paperSel = document.getElementById('fj-paper-size');
        if (paperSel) {
          paperSel.value = 'A5';
          paperSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const portraitRadioEl = document.querySelector('input[name="layout-mode"][value="portrait"]');
        if (portraitRadioEl) {
          portraitRadioEl.checked = true;
          portraitRadioEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        applyFontSize(14, true);
        if (fontFamilyInput) fontFamilyInput.value = '方正金陵';
        applyFontFamily('方正金陵', true);

        // 行距回到“自适应默认值”：列数多时保持 1.5 / 1.0，而不是一律 2.0
        const colCount = contentArea.querySelectorAll('.vertical-paragraph').length;
        let defaultLineHeight = 2.0;
        if (colCount > 8) defaultLineHeight = 1.0;
        else if (colCount > 4) defaultLineHeight = 1.5;
        currentLineHeight = defaultLineHeight;
        contentArea.querySelectorAll('.vertical-paragraph').forEach(para => {
          para.style.lineHeight = defaultLineHeight;
        });
        const lhVal = document.getElementById('fj-lineheight-val');
        if (lhVal) setFieldValue(lhVal, defaultLineHeight.toFixed(1));

        // 页边距回默认 8mm
        currentMarginMm = 8;
        const mVal = document.getElementById('fj-margin-val');
        if (mVal) mVal.textContent = '8';

        // 仿古纸底纹也一起重置为关闭
        currentAntiquePaper = false;
        const antiqueEl = document.getElementById('fj-antique-paper');
        if (antiqueEl) antiqueEl.checked = false;

        // 版框也重置为关闭
        currentAntiqueFrame = false;
        const frameEl = document.getElementById('fj-antique-frame');
        if (frameEl) frameEl.checked = false;

        // 页码也重置为关闭
        currentPageNumber = false;
        const pageNoEl = document.getElementById('fj-page-number');
        if (pageNoEl) pageNoEl.checked = false;

        // 奇偶对称也重置为关闭
        currentPageNumberMirror = false;
        const mirrorEl = document.getElementById('fj-page-number-mirror');
        if (mirrorEl) mirrorEl.checked = false;

        // 装订线归零
        currentGutterMm = 0;
        const gutterEl = document.getElementById('fj-gutter-val');
        if (gutterEl) gutterEl.textContent = '0';

        // 字间距归零
        currentLetterSpacing = 0;
        const lsEl = document.getElementById('fj-letterspacing-val');
        if (lsEl) setFieldValue(lsEl, '0');

        renderVerticalContent(window.editedText || text, false);
        schedulePreviewPages();
        try {
          chrome.storage.local.set({ lineHeight: defaultLineHeight, marginMm: 8, layoutMode: 'portrait', antiquePaper: false, antiqueFrame: false, pageNumber: false, pageNumberMirror: false, gutterMm: 0, letterSpacing: 0 });
        } catch (e) {}
        showToast('版面已重置', 1200);
      };
    }

    // 行距按钮
    if (!applyBtn) {
      console.error('[ERROR] 未找到题目应用按钮');
    }
    if (minusBtn) {
      minusBtn.onclick = () => updateLineHeight(Math.max(1.0, currentLineHeight - 0.1));
    }
    if (plusBtn) {
      plusBtn.onclick = () => updateLineHeight(Math.min(3.0, currentLineHeight + 0.1));
    }
    if (resetBtn) {
      resetBtn.onclick = () => updateLineHeight(2.0);
    }
    // 纸张大小选择
    const paperSizeSelect = document.getElementById('fj-paper-size');
    if (paperSizeSelect) {
      paperSizeSelect.addEventListener('change', (e) => {
        currentPaperSize = e.target.value;
        showToast(`纸张大小已切换为 ${currentPaperSize}`, 1000);
        
        // 左栏纸张预览按 A5/A4 实际尺寸变化，右栏宽度不变
        if (currentPaperSize === 'A5') {
          contentArea.style.width = '148mm';
          contentArea.style.height = '210mm';
        } else {
          contentArea.style.width = '210mm';
          contentArea.style.height = '297mm';
        }
        console.log("[DEBUG] paper size: ", contentArea.style.width, contentArea.style.height);
        try { chrome.storage.local.set({ paperSize: currentPaperSize }); } catch (err) {}
        // ✅ 关键：重新渲染内容，应用新的每列字数
        const currentText = window.editedText || text;
        renderVerticalContent(currentText, false);
      });
    }
    // 清理括号及内容
    const cleanBracketsBtn = document.getElementById('fj-clean-brackets');
    if (cleanBracketsBtn) {
      cleanBracketsBtn.addEventListener('click', () => {
        cleanBracketsAndContent();
      });
    }
    // 自动分段：句末标点后断行
    const autoSplitBtn = document.getElementById('fj-auto-split');
    if (autoSplitBtn) {
      autoSplitBtn.addEventListener('click', () => {
        const el = document.getElementById('fj-body-text');
        if (!el) return;
        const res = autoSplitParagraphs(el.value);
        if (!res.added) { showToast('已经是每句一段了', 1500); return; }
        el.value = res.text;
        if (typeof applyBodyText === 'function') applyBodyText();
        showToast(`已分成 ${res.added} 段`, 1500);
      });
    }

    // 标点替换：把正文里的标点换成竖排（古籍）用法，改完直接刷新预览
    const verticalPunctBtn = document.getElementById('fj-vertical-punct');
    if (verticalPunctBtn) {
      verticalPunctBtn.addEventListener('click', () => {
        const el = document.getElementById('fj-body-text');
        if (!el) return;
        const res = toVerticalPunctuation(el.value);
        if (!res.changed) { showToast('标点已经是竖排用法，无需替换', 1500); return; }
        el.value = res.text;
        if (typeof applyBodyText === 'function') applyBodyText();
        showToast(`已替换 ${res.changed} 处标点`, 1500);
      });
    }
  }, 100);

  // 关闭和复制功能
  const closeBtn = sideHeader.querySelector('#fj-close-panel');
  if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
  // 点击遮罩外不再直接关闭面板（避免误操作），只保留右上角关闭按钮和 Esc
  panel.addEventListener('wheel', (e) => e.stopPropagation());
  
  // 监听复制文本事件
  document.getElementById('fj-copy-text')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); showToast('✅ 文本已复制', 1500); } 
    catch { showToast('❌ 复制失败', 1500); }
  });

  // 监听打印图片事件
  document.getElementById('fj-print-image')?.addEventListener('click', async () => {
    const titleValue = titleInput.value + ' ' + subtitleInput.value;
  
    // 在打印前获取并保存自动关闭状态
    const checkbox = document.getElementById('fj-auto-close');
    const shouldAutoClose = checkbox ? checkbox.checked : false;
    
    console.log('[DEBUG] 打印 - 重新获取的 checkbox 状态:', shouldAutoClose);

    await printImage(panel, contentArea, titleValue);

    // 检查是否需要自动关闭
    if (shouldAutoClose) {
      console.log('[DEBUG] 将自动关闭面板');
      // 延迟关闭，确保打印对话框已打开
      setTimeout(() => {
        if (overlay && overlay.parentNode) {
          console.log('[DEBUG] 执行自动关闭');
          overlay.remove();
        }
      }, 1000);
    }
  });

  // 监听下载图片事件
  document.getElementById('fj-download-image')?.addEventListener('click', async () => {
    const titleValue = titleInput.value + ' ' + subtitleInput.value;

    const checkbox = document.getElementById('fj-auto-close');
    const shouldAutoClose = checkbox ? checkbox.checked : false;
    
    console.log('[DEBUG] 打印 - 重新获取的 checkbox 状态:', shouldAutoClose);
    console.log('[DEBUG] 打印 - checkbox 元素:', checkbox);

    // 优先按“一页一页的真纸张”整张渲染，内容多页也不会被屏幕截断
    const done = await downloadPagesImage(pagesWrap, titleValue);
    if (!done) {
      await captureAndDownload(panel, contentArea, titleValue);
    }

    // 检查是否需要自动关闭
    const autoCloseCheckbox = document.getElementById('fj-auto-close');
    if (shouldAutoClose) {
      console.log('[DEBUG] 将自动关闭面板');
      // 延迟关闭，确保打印对话框已打开
      setTimeout(() => {
        if (overlay && overlay.parentNode) {
          console.log('[DEBUG] 执行自动关闭');
          overlay.remove();
        }
      }, 1000);
    }
  });
}

// 面板里的数值控件可能是 input（可直接填）也可能是 span（旧样式），统一写入
function setFieldValue(el, v) {
  if (!el) return;
  if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) el.value = v;
  else el.textContent = v;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 自动分段：在句末标点（。！？）后断行，若句末跟着收尾引号/括号，标点断在其后
// 已有换行不受影响，不新增空行（换行即一列，古籍竖排习惯每句一列）
function autoSplitParagraphs(src) {
  let s = String(src || '').replace(/\r\n?/g, '\n');
  let added = 0;
  s = s.replace(/([。！？]+[」』）】︾〉”’"']*)([^\n])/g, (m, punct, next) => {
    added++;
    return punct + '\n' + next;
  });
  return { text: s, added };
}

// 把标点换成竖排（古籍）写法：
// 逗号保留顿号语义（逗号仍是逗号，只把半角转全角），双引号 → 「」（配对开关），
// 单引号 → 『』，书名号 → 竖排专用 ︽︾，其余半角标点转全角，英文小数点不动
function toVerticalPunctuation(src) {
  let s = String(src || '');
  let changed = 0;

  // 半角逗号 → 全角逗号（数字之间的 1,000 不动）
  s = s.replace(/,/g, (m, off, str) => {
    const prev = str.charAt(off - 1);
    const next = str.charAt(off + 1);
    if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return m;
    changed++;
    return '，';
  });

  // 半角句号：紧跟在汉字后面的当句号；数字/英文后（3.14、file.txt）保留
  s = s.replace(/([\u4e00-\u9fa5」』）])\./g, (m, prev) => { changed++; return prev + '。'; });

  // 书名号 → 引号（竖排古籍常用「」标举篇名，与正文引号统一）
  s = s.replace(/《/g, () => { changed++; return '「'; });
  s = s.replace(/》/g, () => { changed++; return '」'; });

  // 成对双引号：「 」 交替；中文弯引号直接映射
  let open = true;
  s = s.replace(/"/g, () => { changed++; const ch = open ? '「' : '」'; open = !open; return ch; });
  s = s.replace(/“/g, () => { changed++; return '「'; });
  s = s.replace(/”/g, () => { changed++; return '」'; });

  // 单引号（弯引号）：『 』
  let openSingle = true;
  s = s.replace(/[‘’]/g, () => { changed++; const ch = openSingle ? '『' : '』'; openSingle = !openSingle; return ch; });

  // 其余半角标点转全角
  const map = { ';': '；', ':': '：', '!': '！', '?': '？', '(': '（', ')': '）' };
  s = s.replace(/[;:!?()]/g, (m) => { changed++; return map[m]; });

  return { text: s, changed };
}

function showToast(msg, duration = 2000) {
  console.log('[DEBUG] showToast:', msg);
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `position:fixed; bottom:0; left:50%; transform:translateX(-50%); background:#1e293b; color:white; padding:8px 20px; border-radius:40px; font-size:0.85rem; z-index:10000000; animation:fadeInOut 2s ease;`;
  if (!document.getElementById('toast-anim')) {
    const animStyle = document.createElement('style');
    animStyle.id = 'toast-anim';
    animStyle.textContent = `@keyframes fadeInOut {0%{opacity:0;transform:translateX(-50%) translateY(20px)}15%{opacity:1;transform:translateX(-50%) translateY(0)}85%{opacity:1;transform:translateX(-50%) translateY(0)}100%{opacity:0;transform:translateX(-50%) translateY(-20px)}}`;
    document.head.appendChild(animStyle);
  }
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}


function activateMode() {
  console.log('[DEBUG] ===== 进入 activateMode =====, isSelectionMode:', isSelectionMode);
  if (isSelectionMode) return;

  // 保存当前选中的文字
  const selection = window.getSelection();
  savedSelectedText = selection ? selection.toString().trim() : '';

  // 处理多行选中的文字
  if (savedSelectedText) {
    const lines = savedSelectedText.split(/\r?\n/);
    if (lines.length >= 2) {
      // 第一行作为标题，第二行作为副标题
      savedSelectedText = lines[0].trim();
      savedSubtitleText = lines[1].trim();
      // 如果有更多行，可以作为额外的内容，这里暂时不处理
      console.log('[Content] 检测到多行选中，标题:', savedSelectedText, '副标题:', savedSubtitleText);
    } else {
      savedSelectedText = savedSelectedText;
      savedSubtitleText = '';
    }
  } else {
    savedSelectedText = '';
    savedSubtitleText = '';
  }

  console.log('[Content] 进入选择模式，保存选中文字:', savedSelectedText);
  console.log('[Content] 副标题:', savedSubtitleText);
  
  chrome.storage.sync.get(['smartMode'], (result) => {
    const smartMode = result.smartMode || false;
    console.log('[DEBUG] smartMode:', smartMode);
    
    // 智能模式下，不需要预先设置标题/副标题
    // 等到点击 DIV 时再从内容中解析
    
    isSelectionMode = true;
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('click', onClickHandler, true);
    document.addEventListener('keydown', onKeyDown);
    
    const modeHint = smartMode
      ? '智能模式：第1行→标题，第2行→作者，其余→正文'
      : '手动模式：先选中标题/作者，再点击要提取的 DIV';
    showToast(`🎯 进入选择模式，${modeHint}，按 ESC 退出`, 2000);
  });
}

function onKeyDown(event) { if (event.key === 'Escape') cancelMode(); }

function cancelMode() {
  if (!isSelectionMode) return;
  isSelectionMode = false;
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('mouseout', onMouseOut);
  document.removeEventListener('click', onClickHandler, true);
  document.removeEventListener('keydown', onKeyDown);
  clearHighlight();
  //showToast('🔴 选择模式已关闭', 1200);
}

/*
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ACTIVATE_MODE') { activateMode(); sendResponse({ success: true }); }
  else if (request.action === 'CANCEL_MODE') { cancelMode(); sendResponse({ success: true }); }
  return true;
});
*/

window.addEventListener('beforeunload', () => { if (isSelectionMode) cancelMode(); });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ACTIVATE_MODE') { 
    activateMode(); 
    sendResponse({ success: true }); 
  }
  else if (request.action === 'CANCEL_MODE') { 
    cancelMode(); 
    sendResponse({ success: true }); 
  }
  else if (request.action === 'SHOW_TOAST') { 
    showToast(request.message, 1500); 
    sendResponse({ success: true }); 
  }
  return true;
});

