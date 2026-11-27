'use strict';

(() => {
  const sourceFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);
  function canConvert(asset) {
    return asset.kind === 'image' && !asset.trashed && sourceFormats.has(asset.extension) &&
      asset.byteCount > 0 && asset.byteCount <= 96 * 1024 ** 2;
  }

  window.createJianCangImageConversion = ({ bridge }) => {
    const dialog = document.createElement('dialog');
    dialog.id = 'image-conversion-dialog';
    dialog.className = 'local-intake-dialog structured-export-dialog';
    dialog.setAttribute('aria-labelledby', 'image-conversion-title');
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="image-conversion-title">转换图片</h2>
        <button type="button" class="icon-button" aria-label="关闭" data-convert="close">×</button></div>
      <div class="structured-export-body">
        <form class="structured-export-setup">
          <p class="structured-export-totals" data-convert="count"></p>
          <div class="image-conversion-fields">
            <label class="image-tools-field"><span>格式</span><select name="format">
              <option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option>
            </select></label>
            <label class="image-tools-field"><span>最长边（像素）</span>
              <input name="size" type="number" min="64" max="4096" step="1" value="2048" required>
            </label>
            <label class="image-tools-field" data-convert="quality">
              <span>画质 <output for="image-conversion-quality">90%</output></span>
              <input id="image-conversion-quality" type="range" name="quality" min="20" max="100" step="1" value="90">
            </label>
          </div>
          <p class="structured-export-secondary" data-convert="hint"></p>
          <div class="structured-export-output">
            <h3>保存位置</h3>
            <div class="structured-export-path-row">
              <span class="structured-export-path" data-convert="path">选择导出文件夹</span>
              <button type="button" class="outline-button" data-convert="choose">选择文件夹…</button>
            </div>
          </div>
        </form>
        <div class="image-conversion-progress" data-convert="progress" hidden>
          <progress max="1" value="0" aria-label="图片转换进度"></progress><p role="status"></p>
        </div>
        <section class="structured-export-result" data-convert="result" hidden></section>
        <p class="local-intake-error structured-export-notice" role="alert" hidden></p>
      </div>
      <footer class="structured-export-footer">
        <button type="button" class="outline-button" data-convert="dismiss">取消</button>
        <button type="button" class="primary-button" data-convert="start">导出副本</button>
      </footer>`;
    document.body.append(dialog);
    const read = name => dialog.querySelector(`[data-convert="${name}"]`);
    const [close, count, qualityField, hint, pathLabel, choose, progress, result, dismiss, start] =
      ['close', 'count', 'quality', 'hint', 'path', 'choose', 'progress', 'result', 'dismiss', 'start'].map(read);
    const form = dialog.querySelector('form');
    const { format, size, quality } = form.elements;
    const progressBar = progress.querySelector('progress');
    const progressText = progress.querySelector('p');
    const error = dialog.querySelector('[role="alert"]');
    let references = [];
    let destination;
    let choosing = false;
    let running = false;
    let cancelling = false;
    let finished = false;
    const presets = window.createJianCangExportPresets({
      scope: 'conversion',
      title: '图片导出预设',
      readSettings: settings,
      applySettings(value) {
        format.value = value.format;
        size.value = value.maximumSide;
        quality.value = value.quality;
        update();
      },
      normalizeSettings(value) {
        const { format, maximumSide, quality } = value ?? {};
        if (['jpeg', 'png', 'webp'].includes(format) &&
          Number.isInteger(maximumSide) && maximumSide >= 64 && maximumSide <= 4096 &&
          Number.isInteger(quality) && quality >= 20 && quality <= 100) {
          return { format, maximumSide, quality };
        }
      },
    });
    form.querySelector('.image-conversion-fields').before(presets.panel);

    function settings() {
      return { format: format.value, maximumSide: size.valueAsNumber, quality: quality.valueAsNumber };
    }

    function showError(message = '') {
      error.textContent = message;
      error.hidden = !message;
    }

    function update() {
      form.hidden = finished;
      for (const input of [format, size, quality, choose]) input.disabled = choosing || running;
      presets.setDisabled(choosing || running || finished);
      qualityField.hidden = format.value === 'png';
      qualityField.querySelector('output').value = `${quality.value}%`;
      hint.textContent = format.value === 'jpeg'
        ? '按原比例缩小，小图保持原尺寸。导出静态副本，透明处填白。'
        : '按原比例缩小，小图保持原尺寸。导出静态副本。';
      start.hidden = finished || running;
      start.disabled = choosing || !destination || !size.validity.valid || !references.length || references.length > 1000;
      dismiss.disabled = choosing || cancelling;
      dismiss.textContent = finished ? '完成' : cancelling ? '正在停止…' : running ? '停止转换' : '取消';
      close.disabled = choosing || running;
      progress.hidden = !running;
      result.hidden = !finished;
      pathLabel.textContent = pathLabel.title = destination?.path || '选择导出文件夹';
    }

    function showResult(value) {
      result.replaceChildren();
      const title = document.createElement('h3');
      title.textContent = `${value.cancelled ? '已停止。' : ''}已导出 ${value.written} / ${value.total} 张图片`;
      const location = document.createElement('p');
      location.className = 'structured-export-result-path';
      location.textContent = destination.path;
      result.append(title, location);
      if (value.failed.length) {
        const issues = document.createElement('details');
        issues.className = 'structured-export-failures';
        issues.open = true;
        const label = document.createElement('summary');
        label.textContent = `${value.failed.length} 张未能导出`;
        const rows = document.createElement('ul');
        for (const item of value.failed) {
          const row = document.createElement('li');
          const name = document.createElement('strong');
          const description = document.createElement('span');
          name.textContent = item.name;
          description.textContent = item.message;
          row.append(name, description);
          rows.append(row);
        }
        issues.append(label, rows);
        result.append(issues);
      }
      finished = true;
    }

    async function pickDirectory() {
      choosing = true;
      showError();
      update();
      try {
        const choice = await bridge.chooseStructuredExportDestination();
        if (choice?.cancelled) return;
        if (!choice?.token) throw new Error(choice?.message || '无法选择导出文件夹。');
        destination = choice;
      } catch (problem) { showError(problem.message); }
      finally { choosing = false; update(); }
    }

    async function stopOrClose() {
      if (choosing || cancelling) return;
      if (!running) {
        dialog.close();
        return;
      }
      cancelling = true;
      update();
      try { await bridge.cancelImageConversion(); }
      catch (problem) { cancelling = false; showError(problem.message); update(); }
    }

    async function convert() {
      if (running || start.disabled || finished) return;
      const options = settings();
      running = true;
      showError();
      progressBar.max = references.length;
      progressBar.value = 0;
      progressText.textContent = '正在准备图片…';
      update();
      const detach = bridge.onImageConversionProgress(({ current, processed, total }) => {
        progressBar.max = total;
        progressBar.value = processed;
        progressText.textContent = current ? `${processed} / ${total} · ${current}` : `${processed} / ${total}`;
      });
      try {
        const outcome = await bridge.startImageConversion(references, options, destination.token);
        if (!outcome || outcome.ok === false || !Array.isArray(outcome.failed)) {
          throw new Error(outcome?.message || '图片转换未完成。');
        }
        showResult(outcome);
      } catch (problem) { showError(problem.message); }
      finally {
        detach();
        running = cancelling = false;
        update();
        (finished ? dismiss : start).focus();
      }
    }

    choose.addEventListener('click', () => void pickDirectory());
    start.addEventListener('click', () => void convert());
    close.addEventListener('click', () => dialog.close());
    dismiss.addEventListener('click', () => void stopOrClose());
    form.addEventListener('submit', event => { event.preventDefault(); void convert(); });
    form.addEventListener('input', update);
    dialog.addEventListener('cancel', event => { if (running || choosing) event.preventDefault(); });

    function open(assets) {
      if (dialog.open) return;
      references = assets.filter(canConvert).map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId }));
      const excluded = assets.length - references.length;
      count.textContent = `${references.length} 张可转换${excluded ? `，另有 ${excluded} 项不支持` : ''}`;
      destination = undefined;
      finished = false;
      presets.reset();
      showError(references.length > 1000 ? '每批最多转换 1,000 张图片，请减少选中的图片。' : '');
      update();
      dialog.showModal();
    }
    return { open, canConvert };
  };
})();
