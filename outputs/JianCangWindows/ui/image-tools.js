'use strict';

(() => {
  const maxPixels = 40_000_000;
  const maxDimension = 16_384;
  const maxExportBytes = 96 * 1024 * 1024;
  const maxPreviewDimension = 1200;
  const formatAliases = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };
  const fullRect = { x: 0, y: 0, w: 1, h: 1 };
  const directions = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function withinImageLimit(width, height) {
    return width > 0 && height > 0 && width <= maxDimension && height <= maxDimension && width * height <= maxPixels;
  }

  function originalFormat(asset) {
    const extension = String(asset.fileExtension || asset.extension || '').toLowerCase().replace(/^\./, '');
    return formatAliases[extension] ?? null;
  }

  function fitAspect(rect, ratio) {
    if (!ratio) return rect;
    const w = Math.min(rect.w, rect.h * ratio);
    const h = w / ratio;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
  }

  function moveCrop(rect, dx, dy) {
    return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.w), y: clamp(rect.y + dy, 0, 1 - rect.h) };
  }

  function resizeCrop(rect, corner, dx, dy, ratio, width, height) {
    const fromLeft = corner.includes('w');
    const fromTop = corner.includes('n');
    const anchorX = fromLeft ? rect.x + rect.w : rect.x;
    const anchorY = fromTop ? rect.y + rect.h : rect.y;
    const maxW = fromLeft ? anchorX : 1 - anchorX;
    const maxH = fromTop ? anchorY : 1 - anchorY;
    const minimumW = Math.min(rect.w, Math.max(1 / width, 0.012));
    const minimumH = Math.min(rect.h, Math.max(1 / height, 0.012));
    let w = rect.w + dx * (fromLeft ? -1 : 1);
    let h = rect.h + dy * (fromTop ? -1 : 1);
    if (ratio) {
      const projectedWidth = Math.abs(w - rect.w) * width > Math.abs(h - rect.h) * height ? w : h * ratio;
      w = clamp(projectedWidth, Math.min(maxW, maxH * ratio, Math.max(minimumW, minimumH * ratio)), Math.min(maxW, maxH * ratio));
      h = w / ratio;
    } else {
      w = clamp(w, minimumW, maxW);
      h = clamp(h, minimumH, maxH);
    }
    return { x: fromLeft ? anchorX - w : anchorX, y: fromTop ? anchorY - h : anchorY, w, h };
  }

  function cropPixels(rect, width, height) {
    const x = clamp(Math.round(rect.x * width), 0, width - 1);
    const y = clamp(Math.round(rect.y * height), 0, height - 1);
    return {
      x, y,
      w: clamp(Math.round((rect.x + rect.w) * width), x + 1, width) - x,
      h: clamp(Math.round((rect.y + rect.h) * height), y + 1, height) - y,
    };
  }

  function addAdjustments(context, adjustments) {
    const { brightness, contrast, saturation } = adjustments;
    if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
      context.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    }
  }

  function paint(canvas, state, region, solidBackground = false, usePreview = false) {
    const { image, turns, flipX, flipY, adjustments } = state;
    const { width, height } = dimensions(state);
    const context = canvas.getContext('2d', { alpha: !solidBackground });
    if (!context) throw new Error('图片工具无法绘制这张图片。');

    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (solidBackground) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.scale(canvas.width / region.w, canvas.height / region.h);
    context.translate(width / 2 - region.x, height / 2 - region.y);
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    context.rotate(turns * Math.PI / 2);
    context.imageSmoothingQuality = 'high';
    addAdjustments(context, adjustments);
    context.drawImage(usePreview && state.preview ? state.preview : image,
      -image.naturalWidth / 2, -image.naturalHeight / 2, image.naturalWidth, image.naturalHeight);
    context.restore();
  }

  function dimensions(state) {
    const { naturalWidth, naturalHeight } = state.image;
    return state.turns % 2 ? { width: naturalHeight, height: naturalWidth } : { width: naturalWidth, height: naturalHeight };
  }

  function freshEdits(state) {
    Object.assign(state, {
      turns: 0, flipX: false, flipY: false, aspect: 0, crop: { ...fullRect },
      adjustments: { brightness: 100, contrast: 100, saturation: 100 },
    });
  }

  function hasEdits(state) {
    const { turns, flipX, flipY, crop, adjustments } = state;
    return turns || flipX || flipY || Object.keys(fullRect).some(key => Math.abs(crop[key] - fullRect[key]) > 1e-7)
      || Object.values(adjustments).some(value => value !== 100);
  }

  function makeButtons(dialog) {
    return Object.fromEntries(Array.from(dialog.querySelectorAll('[data-image-action]'),
      button => [button.dataset.imageAction, button]));
  }

  function getScopedURL(value) {
    const url = new URL(value, location.href);
    const sameOrigin = url.protocol === location.protocol && url.host === location.host;
    const nativeMedia = url.pathname.startsWith('/edit-image/') && window.jiancangTauriPlatform?.playbackURL?.(url.href);
    if (url.username || url.password || (!sameOrigin && !nativeMedia)) {
      throw new Error('图片无法在当前编辑窗口读取。');
    }
    return { url: url.href, crossOrigin: !sameOrigin };
  }

  window.createJianCangImageTools = function ({ bridge, getImage, getContentRevision, canReplace, getSyncLibraryId, convertLargeImage, notify }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'image-tools-dialog';
    dialog.setAttribute('aria-labelledby', 'image-tools-heading');
    dialog.innerHTML = `
      <header class="dialog-head image-tools-head">
        <div>
          <h2 id="image-tools-heading">图片工具</h2>
          <p class="image-tools-name"></p>
        </div>
        <button type="button" class="icon-button" data-image-action="close" aria-label="关闭图片工具" title="关闭">×</button>
      </header>
      <div class="image-tools-body">
        <section class="image-tools-stage" aria-label="图片预览">
          <p class="image-tools-stage-status" role="status"></p>
          <div class="image-tools-picture" hidden>
            <canvas aria-label="已调整的图片预览"></canvas>
            <div class="image-tools-shade" aria-hidden="true"></div>
            <div class="image-tools-crop" aria-label="裁切区域">
              <span class="image-tools-grid" aria-hidden="true"></span>
              <button type="button" class="image-tools-move" aria-label="移动裁切框，使用方向键微调"></button>
              <button type="button" class="image-tools-handle" data-corner="nw" aria-label="调整裁切框左上角"></button>
              <button type="button" class="image-tools-handle" data-corner="ne" aria-label="调整裁切框右上角"></button>
              <button type="button" class="image-tools-handle" data-corner="sw" aria-label="调整裁切框左下角"></button>
              <button type="button" class="image-tools-handle" data-corner="se" aria-label="调整裁切框右下角"></button>
            </div>
          </div>
        </section>
        <div class="image-tools-rail">
          <fieldset>
            <legend>裁切</legend>
            <label class="image-tools-field"><span>宽高比</span><select name="crop-ratio">
              <option value="0">自由</option><option value="1">1:1</option><option value="1.3333333333333333">4:3</option>
              <option value="0.75">3:4</option><option value="1.5">3:2</option><option value="0.6666666666666666">2:3</option>
              <option value="1.7777777777777777">16:9</option><option value="0.5625">9:16</option>
            </select></label>
            <p class="image-tools-hint">拖动四角调整范围，拖动框内移动位置。</p>
          </fieldset>
          <fieldset>
            <legend>方向</legend>
            <div class="image-tools-orientation">
              <button type="button" class="outline-button" data-image-action="left">向左旋转</button>
              <button type="button" class="outline-button" data-image-action="right">向右旋转</button>
              <button type="button" class="outline-button" data-image-action="horizontal" aria-pressed="false">水平翻转</button>
              <button type="button" class="outline-button" data-image-action="vertical" aria-pressed="false">垂直翻转</button>
            </div>
          </fieldset>
          <fieldset>
            <legend>调整</legend>
            <label class="image-tools-adjustment"><span>亮度</span><output></output>
              <input name="brightness" type="range" min="50" max="150" step="1"></label>
            <label class="image-tools-adjustment"><span>对比度</span><output></output>
              <input name="contrast" type="range" min="50" max="150" step="1"></label>
            <label class="image-tools-adjustment"><span>饱和度</span><output></output>
              <input name="saturation" type="range" min="0" max="200" step="1"></label>
          </fieldset>
          <fieldset class="image-tools-export">
            <legend>导出与转换</legend>
            <label class="image-tools-field"><span>格式</span><select name="export-format">
              <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
            </select></label>
            <label class="image-tools-field"><span>最长边（像素）</span>
              <input type="number" name="export-maximum" min="64" max="16384" step="1" placeholder="原尺寸">
            </label>
            <label class="image-tools-adjustment image-tools-quality"><span>画质</span><output>94%</output>
              <input name="export-quality" type="range" min="20" max="100" step="1" value="94">
            </label>
            <div class="image-tools-field"><span>导出尺寸</span><output class="image-tools-size">—</output></div>
            <p class="image-tools-hint image-tools-format-hint"></p>
          </fieldset>
        </div>
      </div>
      <div class="image-tools-confirm" role="group" aria-labelledby="image-tools-confirm-title" hidden>
        <div>
          <strong id="image-tools-confirm-title">替换这张素材的原件？</strong>
          <p>替换会保存编辑后的画面，原件中的相机参数、位置等嵌入信息可能会被移除。</p>
        </div>
        <button type="button" class="outline-button" data-image-action="cancel-replace">取消</button>
        <button type="button" class="primary-button" data-image-action="confirm-replace">确认替换</button>
      </div>
      <footer class="image-tools-footer">
        <p class="image-tools-message" role="status"></p>
        <button type="button" class="tool-button" data-image-action="reset">重置调整</button>
        <button type="button" class="outline-button" data-image-action="replace" hidden>替换原件</button>
        <button type="button" class="outline-button" data-image-action="sync-copy" hidden>保存为同步副本</button>
        <button type="button" class="primary-button" data-image-action="export">导出副本</button>
      </footer>`;
    document.body.append(dialog);

    const buttons = makeButtons(dialog);
    const commandGroups = [...dialog.querySelectorAll('fieldset')];
    const stage = dialog.querySelector('.image-tools-stage');
    const stageStatus = dialog.querySelector('.image-tools-stage-status');
    const picture = dialog.querySelector('.image-tools-picture');
    const canvas = picture.querySelector('canvas');
    const cropBox = picture.querySelector('.image-tools-crop');
    const cropMover = cropBox.querySelector('.image-tools-move');
    const ratioSelect = dialog.querySelector('[name="crop-ratio"]');
    const formatSelect = dialog.querySelector('[name="export-format"]');
    const maximumSide = dialog.querySelector('[name="export-maximum"]');
    const quality = dialog.querySelector('[name="export-quality"]');
    const qualityField = quality.closest('label');
    const size = dialog.querySelector('.image-tools-size');
    const formatHint = dialog.querySelector('.image-tools-format-hint');
    const message = dialog.querySelector('.image-tools-message');
    const confirmation = dialog.querySelector('.image-tools-confirm');
    const sliders = [...dialog.querySelectorAll('input[type="range"]:not([name="export-quality"])')];

    let state;
    let drawFrame = 0;
    let drag;

    function canOverwrite() {
      return Boolean(state?.image && !state.previewOnly && state.sourceFormat && canReplace?.(state.asset));
    }

    function updateControls() {
      const ready = Boolean(state?.image);
      const disabled = !ready || state.saving || !confirmation.hidden;
      const replace = canOverwrite();
      const syncCopy = !!state?.syncLibraryId && !state.previewOnly;
      for (const group of commandGroups) group.disabled = disabled;
      buttons.export.disabled = disabled || !maximumSide.validity.valid;
      buttons.reset.disabled = disabled;
      buttons.replace.disabled = disabled || !replace || !hasEdits(state);
      buttons.replace.hidden = !replace;
      buttons['sync-copy'].disabled = disabled || !syncCopy || !hasEdits(state);
      buttons['sync-copy'].hidden = !syncCopy;
      cropBox.inert = disabled;
      buttons.close.disabled = Boolean(state?.saving);
      buttons['confirm-replace'].disabled = Boolean(state?.saving);
      buttons['cancel-replace'].disabled = Boolean(state?.saving);
    }

    function adjustPreviewFit() {
      if (!state?.image || !dialog.open) return;
      const { width, height } = dimensions(state);
      const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height) * 0.94;
      picture.style.width = `${width * scale}px`;
      picture.style.height = `${height * scale}px`;
    }

    function renderPreview() {
      if (drawFrame) return;
      drawFrame = requestAnimationFrame(() => {
        drawFrame = 0;
        if (!state?.image || !dialog.open) return;
        const { width, height } = dimensions(state);
        const scale = Math.min(1, maxPreviewDimension / Math.max(width, height));
        const previewWidth = Math.max(1, Math.round(width * scale));
        const previewHeight = Math.max(1, Math.round(height * scale));
        if (canvas.width !== previewWidth) canvas.width = previewWidth;
        if (canvas.height !== previewHeight) canvas.height = previewHeight;
        paint(canvas, state, { x: 0, y: 0, w: width, h: height }, false, true);
        adjustPreviewFit();
      });
    }

    function renderCrop() {
      const { x, y, w, h } = state.crop;
      Object.assign(cropBox.style, {
        left: `${x * 100}%`, top: `${y * 100}%`,
        width: `${w * 100}%`, height: `${h * 100}%`,
      });
      picture.style.setProperty('--crop-left', `${x * 100}%`);
      picture.style.setProperty('--crop-top', `${y * 100}%`);
      picture.style.setProperty('--crop-right', `${(x + w) * 100}%`);
      picture.style.setProperty('--crop-bottom', `${(y + h) * 100}%`);
      const { width, height } = dimensions(state);
      const pixels = cropPixels(state.crop, width, height);
      const output = exportDimensions(pixels);
      size.value = `${output.width} × ${output.height} 像素`;
      cropMover.setAttribute('aria-description', `${pixels.w} × ${pixels.h} 像素`);
      updateControls();
    }

    function exportDimensions(region) {
      const limit = maximumSide.validity.valid ? maximumSide.valueAsNumber : NaN;
      const scale = Number.isFinite(limit) ? Math.min(1, limit / Math.max(region.w, region.h)) : 1;
      return { width: Math.max(1, Math.round(region.w * scale)), height: Math.max(1, Math.round(region.h * scale)) };
    }

    function syncEdits() {
      ratioSelect.value = String(state.aspect);
      for (const input of sliders) {
        input.value = state.adjustments[input.name];
        input.previousElementSibling.value = `${input.value}%`;
      }
      buttons.horizontal.setAttribute('aria-pressed', String(state.flipX));
      buttons.vertical.setAttribute('aria-pressed', String(state.flipY));
      renderCrop();
      renderPreview();
    }

    function currentRatio({ width, height } = dimensions(state)) {
      return state.aspect * height / width;
    }

    function rotate(direction) {
      const { x, y, w, h } = state.crop;
      state.turns = (state.turns + direction + 4) % 4;
      [state.flipX, state.flipY] = [state.flipY, state.flipX];
      const rotated = direction > 0
        ? { x: 1 - y - h, y: x, w: h, h: w }
        : { x: y, y: 1 - x - w, w: h, h: w };
      state.crop = fitAspect(rotated, currentRatio());
      syncEdits();
    }

    function flip(axis) {
      const { crop } = state;
      if (axis === 'horizontal') {
        state.flipX = !state.flipX;
        crop.x = 1 - crop.x - crop.w;
      } else {
        state.flipY = !state.flipY;
        crop.y = 1 - crop.y - crop.h;
      }
      syncEdits();
    }

    function transformCrop(rect, corner, dx, dy) {
      const { width, height } = dimensions(state);
      state.crop = corner
        ? resizeCrop(rect, corner, dx, dy, currentRatio({ width, height }), width, height)
        : moveCrop(rect, dx, dy);
      renderCrop();
    }

    function changeFormatHint() {
      qualityField.hidden = formatSelect.value === 'png';
      formatHint.textContent = formatSelect.value === 'jpeg'
        ? '导出为静态图片，透明区域填充为白色。'
        : '导出为静态图片。';
    }

    function stopConfirmation() {
      confirmation.hidden = true;
      updateControls();
    }

    function close() {
      if (!state?.saving) dialog.close();
    }

    async function save(mode) {
      const active = state;
      if (!active?.image || active.saving
        || (mode === 'export' && !maximumSide.validity.valid)
        || (mode === 'replace' && (confirmation.hidden || !canOverwrite() || !hasEdits(active)))
        || (mode === 'sync-copy' && (!active.syncLibraryId || active.previewOnly || !hasEdits(active)))) return;
      const format = mode === 'replace' ? active.sourceFormat : formatSelect.value;
      const { width, height } = dimensions(active);
      const region = cropPixels(active.crop, width, height);
      const dimensionsOut = mode === 'export' ? exportDimensions(region) : { width: region.w, height: region.h };
      const output = document.createElement('canvas');
      active.saving = true;
      stopConfirmation();
      message.textContent = mode === 'sync-copy' ? '正在保存同步副本…' : mode === 'replace' ? '正在保存修改…' : '正在生成图片…';
      try {
        output.width = dimensionsOut.width;
        output.height = dimensionsOut.height;
        paint(output, active, region, format === 'jpeg');
        const mime = `image/${format}`;
        const outputQuality = mode === 'export' ? quality.valueAsNumber / 100 : 0.94;
        const blob = await new Promise(resolve => output.toBlob(resolve, mime, outputQuality));
        if (!blob || blob.type !== mime) throw new Error('无法生成所选格式，请切换格式后再试。');
        if (blob.size > maxExportBytes) throw new Error('输出超过 96 MB，请缩小裁切范围或改用 JPEG。');
        output.width = 0;
        output.height = 0;
        const result = await bridge.saveEditedImage({
          id: active.asset.sourceAssetId,
          registrationId: active.asset.sourceLibraryId,
          revision: active.asset.mediaRevision,
          contentRevision: getContentRevision?.(active.asset),
          ...(mode === 'sync-copy' && { expectedLibraryId: active.syncLibraryId }),
          mode, format, ...dimensionsOut,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
        if (state !== active) return;
        if (result?.ok) {
          dialog.close();
          notify?.(result.message || (mode === 'replace' ? '已替换原件。' : '已导出图片副本。'), result);
          return;
        }
        message.textContent = result?.cancelled || result?.canceled
          ? active.sourceHint : (result?.error || result?.message || '图片还未保存，请重试。');
      } catch (error) {
        if (state === active) message.textContent = error?.message || '图片还未保存，请重试。';
      } finally {
        output.width = 0;
        output.height = 0;
        if (state === active) {
          active.saving = false;
          updateControls();
          if (dialog.open) buttons[mode].focus();
        }
      }
    }

    async function open(asset) {
      if (!asset || state?.saving) return;
      const { width, height } = asset;
      if (width > 0 && height > 0 && !withinImageLimit(width, height) && convertLargeImage) {
        convertLargeImage(asset);
        return;
      }
      const sourceFormat = originalFormat(asset);
      const active = { asset, sourceFormat, syncLibraryId: getSyncLibraryId?.(asset), image: null, saving: false, previewOnly: false, sourceHint: '' };
      freshEdits(active);
      state?.preview?.close();
      state = active;
      drag = null;
      message.textContent = '';
      confirmation.hidden = true;
      picture.hidden = true;
      stageStatus.hidden = false;
      stageStatus.textContent = '正在读取图片…';
      dialog.querySelector('.image-tools-name').textContent = asset.name || asset.title || '';
      size.value = '—';
      formatSelect.value = sourceFormat ?? 'png';
      maximumSide.value = '';
      quality.value = '94';
      quality.previousElementSibling.value = '94%';
      changeFormatHint();
      updateControls();
      if (!dialog.open) dialog.showModal();
      try {
        if (width > 0 && height > 0 && !withinImageLimit(width, height)) {
          throw new Error('这张图超出可编辑尺寸。图片工具支持 4000 万像素以内，每边最长 16384 像素。');
        }
        const source = await getImage(asset);
        if (state !== active || !dialog.open) return;
        const sourceURL = typeof source === 'string' ? source : source?.url;
        if (!sourceURL) throw new Error('原件暂时无法读取，请确认文件已下载后重试。');
        const image = new Image();
        image.decoding = 'async';
        const scoped = getScopedURL(sourceURL);
        if (scoped.crossOrigin) image.crossOrigin = 'anonymous';
        image.src = scoped.url;
        try {
          await image.decode();
        } catch {
          throw new Error('原件无法解码。请确认文件已下载，或用系统应用检查图片能否打开。');
        }
        if (state !== active || !dialog.open) return;
        if (!withinImageLimit(image.naturalWidth, image.naturalHeight)) {
          if (convertLargeImage) {
            dialog.close();
            convertLargeImage(asset);
            return;
          }
          throw new Error('这张图超出可编辑尺寸。图片工具支持 4000 万像素以内，每边最长 16384 像素。');
        }
        active.image = image;
        active.previewOnly = Boolean(source?.previewOnly);
        if (active.previewOnly) active.sourceHint = '当前使用预览图，导出按显示的像素尺寸保存。';
        message.textContent = active.sourceHint;
        stageStatus.hidden = true;
        picture.hidden = false;
        syncEdits();
        const scale = Math.min(1, maxPreviewDimension / Math.max(image.naturalWidth, image.naturalHeight));
        if (scale < 1) {
          try {
            const preview = await createImageBitmap(image, {
              resizeWidth: Math.max(1, Math.round(image.naturalWidth * scale)),
              resizeHeight: Math.max(1, Math.round(image.naturalHeight * scale)),
              resizeQuality: 'high',
            });
            if (state === active && dialog.open) {
              active.preview = preview;
              renderPreview();
            } else preview.close();
          } catch {}
        }
      } catch (error) {
        if (state === active && dialog.open) stageStatus.textContent = error?.message || '图片读取失败。';
      }
    }

    new ResizeObserver(adjustPreviewFit).observe(stage);
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      state?.preview?.close();
      state = null;
      drag = null;
      if (drawFrame) cancelAnimationFrame(drawFrame);
      drawFrame = 0;
      canvas.width = 0;
      canvas.height = 0;
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (!confirmation.hidden && !state?.saving) {
        stopConfirmation();
        buttons.replace.focus();
      } else close();
    });

    buttons.close.addEventListener('click', close);
    buttons.left.addEventListener('click', () => rotate(-1));
    buttons.right.addEventListener('click', () => rotate(1));
    buttons.horizontal.addEventListener('click', () => flip('horizontal'));
    buttons.vertical.addEventListener('click', () => flip('vertical'));
    buttons.reset.addEventListener('click', () => {
      freshEdits(state);
      syncEdits();
    });
    buttons.replace.addEventListener('click', () => {
      if (!canOverwrite()) return;
      confirmation.hidden = false;
      updateControls();
      buttons['cancel-replace'].focus();
    });
    buttons['cancel-replace'].addEventListener('click', () => {
      stopConfirmation();
      buttons.replace.focus();
    });
    buttons['confirm-replace'].addEventListener('click', () => void save('replace'));
    buttons['sync-copy'].addEventListener('click', () => void save('sync-copy'));
    buttons.export.addEventListener('click', () => void save('export'));

    ratioSelect.addEventListener('change', () => {
      state.aspect = Number(ratioSelect.value);
      if (state.aspect) state.crop = fitAspect(fullRect, currentRatio());
      renderCrop();
    });
    formatSelect.addEventListener('change', changeFormatHint);
    maximumSide.addEventListener('input', () => { if (state?.image) renderCrop(); });
    quality.addEventListener('input', () => { quality.previousElementSibling.value = `${quality.value}%`; });
    for (const input of sliders) input.addEventListener('input', () => {
      state.adjustments[input.name] = Number(input.value);
      input.previousElementSibling.value = `${input.value}%`;
      updateControls();
      renderPreview();
    });

    cropBox.addEventListener('pointerdown', event => {
      const button = event.target.closest('button');
      const rect = picture.getBoundingClientRect();
      if (!button || !event.isPrimary || event.button !== 0 || !rect.width || !rect.height) return;
      drag = { id: event.pointerId, corner: button.dataset.corner, x: event.clientX, y: event.clientY, rect, crop: state.crop };
      cropBox.setPointerCapture(event.pointerId);
    });
    cropBox.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      transformCrop(drag.crop, drag.corner, (event.clientX - drag.x) / drag.rect.width, (event.clientY - drag.y) / drag.rect.height);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      cropBox.addEventListener(event, ({ pointerId }) => {
        if (drag?.id === pointerId) drag = null;
      });
    }
    cropBox.addEventListener('keydown', event => {
      const button = event.target.closest('button');
      const direction = directions[event.key];
      if (!button || !direction) return;
      event.preventDefault();
      event.stopPropagation();
      const { width, height } = dimensions(state);
      const step = event.shiftKey ? 10 : 1;
      transformCrop(state.crop, button.dataset.corner, direction[0] * step / width, direction[1] * step / height);
    });

    return { open };
  };
})();
