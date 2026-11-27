'use strict';

(() => {
  const resources = 'jiancang://app/pdfjs/';
  const chunkSize = 64 * 1024;
  const maxBytes = 128 * 1024 ** 2;
  let modulePromise;

  function loadModule() {
    modulePromise ??= import(`${resources}build/pdf.min.mjs`).catch(error => {
      modulePromise = null;
      throw error;
    });
    return modulePromise;
  }

  async function readRange(url, begin, end, size, signal) {
    const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${begin}-${end - 1}/${size}`) {
      await response.body?.cancel();
      throw new Error('无法读取 PDF 原件。');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - begin) throw new Error('PDF 原件尚未完整到齐。');
    return bytes;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  window.mountJianCangPdfPreview = (host, { url, asset, initialPage, onPage, onError, makeButton }) => {
    const frame = makeElement('section', 'pdf-preview');
    frame.setAttribute('aria-label', 'PDF 文档');
    const paper = makeElement('div', 'pdf-preview-paper');
    const waiting = makeElement('span', 'pdf-preview-status', '正在读取 PDF…');
    waiting.setAttribute('role', 'status');
    paper.append(waiting);
    const navigation = makeElement('div', 'pdf-preview-navigation');
    navigation.setAttribute('role', 'group');
    navigation.setAttribute('aria-label', 'PDF 页码');
    navigation.hidden = true;
    const previous = makeButton('', 'chevronLeft', 'icon-button', () => move(-1));
    const next = makeButton('', 'chevronRight', 'icon-button', () => move(1));
    previous.title = 'PDF 上一页';
    next.title = 'PDF 下一页';
    previous.setAttribute('aria-label', previous.title);
    next.setAttribute('aria-label', next.title);
    const pageNumber = makeElement('input', 'pdf-preview-page');
    pageNumber.type = 'number';
    pageNumber.min = '1';
    pageNumber.setAttribute('aria-label', '跳转到 PDF 页码');
    const total = makeElement('span', 'pdf-preview-total');
    navigation.append(previous, pageNumber, total, next);
    frame.append(paper, navigation);
    host.replaceChildren(frame);

    const controller = new AbortController();
    let pdf;
    let loading;
    let port;
    let worker;
    let rendering;
    let page = 1;
    let paint;
    let paintKey;
    let sequence = 0;
    let timer;
    let disposed = false;
    let started = false;

    const observer = new ResizeObserver(() => {
      if (disposed || !paper.clientWidth || !paper.clientHeight) return;
      if (started) queuePaint();
      else {
        started = true;
        timer = setTimeout(() => fail(new Error('读取 PDF 超时，请重新读取。')), 30_000);
        void load().catch(fail);
      }
    });
    observer.observe(paper);

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      observer.disconnect();
      cancelAnimationFrame(paint);
      rendering?.cancel();
      const finish = () => {
        worker?.destroy();
        port?.terminate();
      };
      if (!loading) finish();
      else {
        const deadline = setTimeout(finish, 800);
        void loading.destroy().catch(() => {}).finally(() => {
          clearTimeout(deadline);
          finish();
        });
      }
    }

    function fail(error) {
      if (disposed) return;
      const message = error.name === 'PasswordException' ? '此 PDF 需要密码。可导出原件后打开。'
        : error.name === 'InvalidPDFException' ? 'PDF 已损坏或格式不受支持。'
          : error.message?.startsWith('读取 PDF 超时') ? error.message : '暂时无法预览 PDF，可重新读取或导出原件。';
      dispose();
      onError(message);
    }

    async function load() {
      const size = asset.byteCount;
      if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
        dispose();
        onError(size > maxBytes ? '此 PDF 超过 128 MB，可导出原件后打开。' : 'PDF 原件为空或尚未同步完成。');
        return;
      }
      const [library, header] = await Promise.all([
        loadModule(), readRange(url, 0, Math.min(size, chunkSize), size, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      port = new Worker(`${resources}build/pdf.worker.min.mjs`, { type: 'module' });
      port.addEventListener('error', fail, { once: true });
      port.addEventListener('messageerror', fail, { once: true });
      worker = library.PDFWorker.create({ port });
      const range = new library.PDFDataRangeTransport(size, header, true);
      range.requestDataRange = (begin, end) => {
        void readRange(url, begin, end, size, controller.signal).then(bytes => {
          if (!disposed) range.onDataRange(begin, bytes);
        }).catch(fail);
      };
      range.abort = () => controller.abort();
      loading = library.getDocument({
        range, worker, rangeChunkSize: chunkSize, disableStream: true, disableAutoFetch: true,
        disableWorkerRendering: true, enableXfa: false, useWorkerFetch: true,
        cMapUrl: `${resources}cmaps/`, standardFontDataUrl: `${resources}standard_fonts/`,
        wasmUrl: `${resources}wasm/`, iccUrl: `${resources}iccs/`,
        maxImageSize: 32 * 1024 ** 2, canvasMaxAreaInBytes: 64 * 1024 ** 2,
      });
      pdf = await loading.promise;
      if (disposed) return;
      setPage(initialPage, false);
      navigation.hidden = false;
    }

    function setPage(target, remember = true) {
      if (disposed || !pdf) return false;
      const nextPage = Math.min(Math.max(1, Number.isInteger(target) ? target : page), pdf.numPages);
      page = nextPage;
      pageNumber.value = String(page);
      pageNumber.max = String(pdf.numPages);
      total.textContent = `/ ${pdf.numPages}`;
      previous.disabled = page === 1;
      next.disabled = page === pdf.numPages;
      if (remember) onPage(page);
      queuePaint();
      return true;
    }

    function move(delta) {
      return setPage(page + delta);
    }

    pageNumber.addEventListener('change', () => setPage(pageNumber.valueAsNumber));
    pageNumber.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      setPage(pageNumber.valueAsNumber);
    });

    function queuePaint() {
      if (paint || !pdf || disposed) return;
      paint = requestAnimationFrame(() => {
        paint = 0;
        void draw().catch(fail);
      });
    }

    async function draw() {
      const width = paper.clientWidth - 12;
      const height = paper.clientHeight - 12;
      if (width <= 0 || height <= 0) return;
      const key = `${page}:${width}:${height}:${devicePixelRatio}`;
      if (paintKey === key) return;
      paintKey = key;
      const renderSequence = ++sequence;
      const pageIndex = page;
      rendering?.cancel();
      const pdfPage = await pdf.getPage(pageIndex);
      if (disposed || renderSequence !== sequence) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      if (!(natural.width > 0 && natural.height > 0)) throw new Error('PDF 页面尺寸无效。');
      const scale = Math.min(width / natural.width, height / natural.height);
      const viewport = pdfPage.getViewport({ scale });
      const density = Math.min(devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
      const canvas = makeElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.dataset.pdfPage = String(pageIndex);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${asset.name} 第 ${pageIndex} 页`);
      const job = pdfPage.render({
        canvas, viewport, transform: [density, 0, 0, density, 0, 0],
        annotationMode: 0,
      });
      rendering = job;
      try {
        await job.promise;
        if (disposed || renderSequence !== sequence) return;
        clearTimeout(timer);
        paper.replaceChildren(canvas);
      } catch (error) {
        if (error.name !== 'RenderingCancelledException') throw error;
      } finally {
        if (rendering === job) rendering = null;
      }
    }

    return { dispose, move };
  };
})();
