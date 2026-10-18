// ==UserScript==
// @name         Edge网页长截屏导出PDF（分页+分图）
// @namespace    https://github.com/lookingsbfor
// @version      3.1
// @description  自动加载动态内容 + 全页长截图，按 A4 比例分页导出 PDF 或拆分保存图片
// @author       lookingsbfor
// @license      MIT
// @homepageURL  https://github.com/lookingsbfor/edge-long-screenshot-pdf
// @supportURL   https://github.com/lookingsbfor/edge-long-screenshot-pdf/issues
// @downloadURL  https://raw.githubusercontent.com/lookingsbfor/edge-long-screenshot-pdf/main/edge-long-screenshot-pdf.user.js
// @updateURL    https://raw.githubusercontent.com/lookingsbfor/edge-long-screenshot-pdf/main/edge-long-screenshot-pdf.user.js
// @match        *://*/*
// @noframes
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @run-at       document-idle
// ==/UserScript==

/*
 * v3.1 修复记录
 * 1. 修正 A4 切块比例：块高由 canvas 宽度换算，不再用 297mm 换算的固定像素值。
 *    旧版未乘 devicePixelRatio，导致分页数量错误且页面被严重拉伸变形。
 * 2. 新增 canvas 尺寸上限保护，超长页面自动降低 scale，避免浏览器 canvas 超限导致截图空白。
 * 3. 截图根元素改为 documentElement，并补 windowWidth/windowHeight/scrollX/scrollY，
 *    修复 position:fixed 元素重复渲染、body margin 导致留白的问题。
 * 4. 预览图与下载改用 Blob URL，避免整张长图的 base64 字符串撑爆内存。
 * 5. 导出默认 JPEG（PNG 的 quality 参数是无效的），体积约为原来的 1/10。
 * 6. 多图下载改为间隔触发，避免被浏览器一次性拦截。
 * 7. @grant 改为 none，html2canvas / jsPDF 在页面上下文运行，避免 GM 沙箱下的兼容性问题。
 */

(function () {
    'use strict';

    // ---------- 配置 ----------
    const CONFIG = {
        loadTimeout: 15000,          // 动态内容加载总超时（ms）
        scrollDelay: 800,            // 每次滚动到底后的等待（ms）
        scrollInterval: 120,         // 滚动过程中每一步的间隔（ms）
        previewWidth: 900,           // 预览窗口宽度（px）
        a4WidthMm: 210,
        a4HeightMm: 297,
        imageType: 'image/jpeg',     // image/jpeg 或 image/png
        imageQuality: 0.92,          // 仅对 jpeg/webp 生效
        maxCanvasPixels: 180 * 1024 * 1024, // 浏览器 canvas 面积上限约 2^28，这里留余量
        maxCanvasSide: 65535,        // 浏览器 canvas 单边上限
        downloadInterval: 400,       // 多图连续下载间隔（ms）
        hideFixedElements: false     // 是否过滤页面的 position:fixed 元素（导航栏等）
    };

    const A4_RATIO = CONFIG.a4HeightMm / CONFIG.a4WidthMm; // 297 / 210
    const IMG_EXT = CONFIG.imageType === 'image/png' ? 'png' : 'jpg';
    const PDF_FMT = CONFIG.imageType === 'image/png' ? 'PNG' : 'JPEG';

    // ---------- 工具函数 ----------
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function safeName(name) {
        return (name || '网页截图').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80).trim();
    }

    function timestamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    function canvasToBlob(canvas) {
        return new Promise(resolve => {
            if (canvas.toBlob) {
                canvas.toBlob(b => resolve(b), CONFIG.imageType, CONFIG.imageQuality);
            } else {
                const parts = canvas.toDataURL(CONFIG.imageType, CONFIG.imageQuality).split(',');
                const bin = atob(parts[1]);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                resolve(new Blob([arr], { type: CONFIG.imageType }));
            }
        });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(blob);
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    // ---------- 注入样式 ----------
    const style = document.createElement('style');
    style.textContent = `
        #edge-screenshot-panel {
            position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
            background: #fff; padding: 12px; border-radius: 8px;
            box-shadow: 0 2px 12px rgba(0,0,0,.15); border: 1px solid #e5e7eb;
            font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            min-width: 150px;
        }
        #edge-screenshot-panel .sp-title {
            font-size: 12px; color: #6b7280; margin-bottom: 8px; display: flex;
            justify-content: space-between; align-items: center; gap: 8px;
        }
        #edge-screenshot-panel .sp-fold { cursor: pointer; color: #9ca3af; }
        #edge-screenshot-panel button {
            display: block; width: 100%; padding: 9px 0; margin: 0 0 8px;
            border: none; border-radius: 6px; cursor: pointer;
            font-size: 14px; font-weight: 500; background: #0078d4; color: #fff;
            transition: background .2s;
        }
        #edge-screenshot-panel button:hover:not(:disabled) { background: #005a9e; }
        #edge-screenshot-panel button:disabled { background: #ced4da; cursor: not-allowed; }
        #edge-screenshot-panel .sp-status { font-size: 12px; color: #6b7280; max-width: 180px; }
        #edge-screenshot-panel.folded .sp-body { display: none; }
        #screenshot-preview-modal {
            position: fixed; inset: 0; z-index: 2147483001; display: none;
            font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .preview-mask { position: absolute; inset: 0; background: rgba(0,0,0,.7); }
        .preview-content {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: calc(100% - 40px); max-width: ${CONFIG.previewWidth}px; max-height: 90vh;
            background: #fff; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column;
        }
        .preview-header {
            padding: 12px 16px; background: #f8f9fa; border-bottom: 1px solid #e5e7eb;
            display: flex; justify-content: space-between; align-items: center; gap: 12px;
        }
        .preview-header span { font-size: 16px; font-weight: 600; color: #333; }
        .preview-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .preview-header-actions button {
            padding: 6px 12px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer;
        }
        #export-pdf-btn { background: #0078d4; color: #fff; }
        #export-pdf-btn:hover { background: #005a9e; }
        #split-save-img-btn { background: #28a745; color: #fff; }
        #split-save-img-btn:hover { background: #218838; }
        #close-preview-btn { width: 28px; height: 28px; border: none; background: transparent;
            font-size: 20px; color: #666; cursor: pointer; line-height: 1; border-radius: 50%; }
        #close-preview-btn:hover { color: #000; background: #eee; }
        .preview-body { padding: 16px; overflow-y: auto; }
        #preview-img { width: 100%; height: auto; border-radius: 4px; display: block; }
        #split-tips { margin-top: 12px; color: #666; font-size: 14px; }
    `;
    document.head.appendChild(style);

    // ---------- 构建 UI ----------
    const panel = document.createElement('div');
    panel.id = 'edge-screenshot-panel';
    panel.innerHTML = `
        <div class="sp-title"><span>网页长截屏</span><span class="sp-fold" title="收起/展开">—</span></div>
        <div class="sp-body">
            <button id="start-capture-btn">开始截图</button>
            <div class="sp-status" id="capture-status">就绪</div>
        </div>
    `;
    document.body.appendChild(panel);

    const modal = document.createElement('div');
    modal.id = 'screenshot-preview-modal';
    modal.innerHTML = `
        <div class="preview-mask"></div>
        <div class="preview-content">
            <div class="preview-header">
                <span>截图预览</span>
                <div class="preview-header-actions">
                    <button id="export-pdf-btn">导出 PDF（分页）</button>
                    <button id="split-save-img-btn">分割存图片</button>
                    <button id="close-preview-btn">&times;</button>
                </div>
            </div>
            <div class="preview-body">
                <img id="preview-img" alt="截图预览" />
                <div id="split-tips"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const $ = id => document.getElementById(id);
    const setStatus = txt => { $('capture-status').textContent = txt; };

    panel.querySelector('.sp-fold').addEventListener('click', () => panel.classList.toggle('folded'));

    // ---------- 状态 ----------
    let blocks = [];        // 拆分后的 canvas
    let meta = null;        // { width, height, pages, title }
    let isCapturing = false;
    let previewUrl = null;

    // ---------- 1. 预加载动态内容 ----------
    async function loadAllDynamicContent() {
        const start = Date.now();
        let lastHeight = document.documentElement.scrollHeight;
        window.scrollTo(0, 0);
        await sleep(200);

        while (Date.now() - start < CONFIG.loadTimeout) {
            const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
            for (let y = 0; y < lastHeight; y += step) {
                window.scrollTo(0, y);
                await sleep(CONFIG.scrollInterval);
            }
            window.scrollTo(0, lastHeight);
            await sleep(CONFIG.scrollDelay);

            const nowHeight = document.documentElement.scrollHeight;
            if (nowHeight <= lastHeight) break;
            lastHeight = nowHeight;
            setStatus(`加载动态内容中…（高度 ${nowHeight}px）`);
        }
        window.scrollTo(0, 0);
        await sleep(300);
    }

    // ---------- 2. 计算安全的 scale ----------
    function calcScale(w, h) {
        let scale = Math.min(window.devicePixelRatio || 1, 2);
        scale = Math.max(scale, 1);
        // 面积限制
        if (w * h * scale * scale > CONFIG.maxCanvasPixels) {
            scale = Math.sqrt(CONFIG.maxCanvasPixels / (w * h));
        }
        // 单边限制
        if (h * scale > CONFIG.maxCanvasSide) scale = CONFIG.maxCanvasSide / h;
        if (w * scale > CONFIG.maxCanvasSide) scale = CONFIG.maxCanvasSide / w;
        return Math.max(0.4, Number(scale.toFixed(2)));
    }

    // ---------- 3. A4 比例切块 ----------
    function splitCanvasToA4(canvas) {
        const out = [];
        const totalW = canvas.width;
        const totalH = canvas.height;
        const blockH = Math.max(1, Math.round(totalW * A4_RATIO)); // 关键：按宽度换算，比例恒为 A4
        let y = 0;

        while (y < totalH) {
            const h = Math.min(blockH, totalH - y);
            const c = document.createElement('canvas');
            c.width = totalW;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';          // JPEG 无 alpha，先铺白底
            ctx.fillRect(0, 0, totalW, h);
            ctx.drawImage(canvas, 0, y, totalW, h, 0, 0, totalW, h);
            out.push(c);
            y += h;
        }
        return out;
    }

    // ---------- 4. 截图主流程 ----------
    $('start-capture-btn').addEventListener('click', async () => {
        if (isCapturing) return;
        if (typeof window.html2canvas !== 'function') {
            alert('html2canvas 未加载成功，请检查网络或 CDN 是否被拦截。');
            return;
        }

        isCapturing = true;
        const btn = $('start-capture-btn');
        btn.disabled = true;
        btn.textContent = '处理中…';

        try {
            setStatus('正在加载动态内容…');
            await loadAllDynamicContent();

            const fullWidth = document.documentElement.clientWidth;
            const fullHeight = Math.max(
                document.body.scrollHeight, document.documentElement.scrollHeight,
                document.body.offsetHeight, document.documentElement.offsetHeight
            );
            const scale = calcScale(fullWidth, fullHeight);
            setStatus(`正在渲染（${fullWidth}×${fullHeight}，scale ${scale}）…`);

            const canvas = await window.html2canvas(document.documentElement, {
                x: 0,
                y: 0,
                width: fullWidth,
                height: fullHeight,
                windowWidth: document.documentElement.clientWidth,
                windowHeight: fullHeight,
                scrollX: 0,
                scrollY: 0,
                scale: scale,
                useCORS: true,
                allowTaint: false,
                backgroundColor: '#ffffff',
                logging: false,
                removeContainer: true,
                ignoreElements: el => {
                    if (el.id === 'edge-screenshot-panel' || el.id === 'screenshot-preview-modal') return true;
                    if (el.tagName === 'STYLE' && el.textContent.includes('#edge-screenshot-panel')) return true;
                    if (CONFIG.hideFixedElements && getComputedStyle(el).position === 'fixed') return true;
                    return false;
                }
            });

            blocks = splitCanvasToA4(canvas);
            meta = { width: canvas.width, height: canvas.height, pages: blocks.length, title: safeName(document.title) };

            setStatus(`截图完成，共 ${blocks.length} 页`);

            // 预览用 blob URL，避免超长 base64
            const previewBlob = await canvasToBlob(canvas);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = URL.createObjectURL(previewBlob);
            $('preview-img').src = previewUrl;
            $('split-tips').textContent =
                `原始尺寸 ${canvas.width}×${canvas.height}，已按 A4 比例拆分为 ${blocks.length} 张图片。`;
            $('screenshot-preview-modal').style.display = 'block';

            canvas.width = canvas.height = 0; // 释放整张大图内存
        } catch (err) {
            console.error(err);
            alert(`截图失败：${err && err.message ? err.message : err}\n若为跨域图片，请确认站点允许 CORS。`);
            setStatus('截图失败');
        } finally {
            btn.disabled = false;
            btn.textContent = '开始截图';
            isCapturing = false;
        }
    });

    // ---------- 5. 导出分页 PDF ----------
    $('export-pdf-btn').addEventListener('click', async () => {
        if (!blocks.length) return alert('请先完成截图！');
        const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!JsPDF) return alert('jsPDF 未加载成功，请检查网络或 CDN 是否被拦截。');

        const btn = $('export-pdf-btn');
        btn.disabled = true;
        btn.textContent = '生成中…';
        try {
            const pdf = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
            for (let i = 0; i < blocks.length; i++) {
                if (i > 0) pdf.addPage('a4', 'portrait');
                const dataUrl = await blobToDataUrl(await canvasToBlob(blocks[i]));
                const heightMm = CONFIG.a4WidthMm * (blocks[i].height / blocks[i].width); // 末页不拉伸
                pdf.addImage(dataUrl, PDF_FMT, 0, 0, CONFIG.a4WidthMm, heightMm);
                btn.textContent = `生成中… ${i + 1}/${blocks.length}`;
                await sleep(0);
            }
            pdf.save(`${meta.title}_分页_${timestamp()}.pdf`);
            setStatus(`PDF 已导出，共 ${blocks.length} 页`);
        } catch (err) {
            console.error(err);
            alert(`PDF 生成失败：${err && err.message ? err.message : err}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '导出 PDF（分页）';
        }
    });

    // ---------- 6. 拆分保存图片 ----------
    $('split-save-img-btn').addEventListener('click', async () => {
        if (!blocks.length) return alert('请先完成截图！');
        if (blocks.length > 30 &&
            !confirm(`将下载 ${blocks.length} 个文件，浏览器可能会弹出"是否允许批量下载"的询问。继续？`)) return;

        const btn = $('split-save-img-btn');
        btn.disabled = true;
        try {
            for (let i = 0; i < blocks.length; i++) {
                btn.textContent = `保存中… ${i + 1}/${blocks.length}`;
                const blob = await canvasToBlob(blocks[i]);
                downloadBlob(blob, `${meta.title}_${String(i + 1).padStart(2, '0')}.${IMG_EXT}`);
                await sleep(CONFIG.downloadInterval);
            }
            setStatus(`已保存 ${blocks.length} 张图片`);
        } catch (err) {
            console.error(err);
            alert(`图片保存失败：${err && err.message ? err.message : err}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '分割存图片';
        }
    });

    // ---------- 7. 关闭预览 ----------
    function closePreview() { $('screenshot-preview-modal').style.display = 'none'; }
    $('close-preview-btn').addEventListener('click', closePreview);
    modal.querySelector('.preview-mask').addEventListener('click', closePreview);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closePreview();
        if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
            panel.classList.toggle('folded');
        }
    });
})();
