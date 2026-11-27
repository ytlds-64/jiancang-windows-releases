'use strict';

(() => {
  const frameCount = 12;
  const minimumRange = 0.1;
  const maximumDuration = 24 * 60 * 60;
  const precision = 1000;
  const tickIntervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function timecode(seconds, detailed = true) {
    const milliseconds = Math.max(0, Math.round(seconds * precision));
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds / 60_000) % 60;
    const whole = Math.floor(milliseconds / 1000) % 60;
    const prefix = hours ? `${hours}:` : '';
    const base = `${prefix}${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}`;
    return detailed ? `${base}.${String(milliseconds % 1000).padStart(3, '0')}` : base;
  }

  function parseTimecode(text) {
    const parts = text.trim().replace(',', '.').split(':');
    if (!parts.length || parts.length > 3 || !/^\d+(\.\d{1,3})?$/.test(parts.at(-1)) ||
        parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return NaN;
    if (parts.length > 1 && (Number(parts.at(-1)) >= 60 || (parts.length === 3 && Number(parts[1]) >= 60))) return NaN;
    return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
  }

  function safeURL(value) {
    const url = typeof value === 'string' && URL.parse(value);
    return url?.protocol === 'jiancang:' && !url.username && !url.password ? url.href : '';
  }

  function waitForMedia(media, type, isReady, signal, timeout = 3000) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (isReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      function clear() {
        clearTimeout(timer);
        media.removeEventListener(type, ready);
        media.removeEventListener('error', fail);
        signal.removeEventListener('abort', fail);
      }
      function ready() {
        if (!isReady()) return;
        clear();
        resolve();
      }
      function fail() {
        clear();
        reject(signal.reason || new Error('无法读取视频画面。'));
      }
      const timer = setTimeout(fail, timeout);
      media.addEventListener(type, ready);
      media.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', fail, { once: true });
    });
  }

  function releaseVideo(video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function coverFrame(context, video, left, width, height) {
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const sourceWidth = width / scale;
    const sourceHeight = height / scale;
    context.drawImage(video, (video.videoWidth - sourceWidth) / 2, (video.videoHeight - sourceHeight) / 2,
      sourceWidth, sourceHeight, left, 0, width, height);
  }

  window.createJianCangVideoTrim = ({ bridge, getVideo, getPoster, notify = () => {} }) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'video-trim-dialog';
    dialog.setAttribute('aria-labelledby', 'video-trim-title');
    dialog.innerHTML = `
      <header class="dialog-head video-trim-head">
        <div><h2 id="video-trim-title">裁剪视频</h2><div class="video-trim-name"></div></div>
        <button type="button" class="icon-button" data-trim="close" aria-label="关闭视频裁剪">×</button>
      </header>
      <div class="video-trim-stage">
        <video playsinline preload="auto" disablepictureinpicture></video>
        <div class="video-trim-stage-notice">
          <p class="video-trim-stage-status" role="status">正在读取视频…</p>
          <button type="button" class="outline-button" data-trim="make-preview" hidden>生成兼容预览</button>
        </div>
      </div>
      <section class="video-trim-editor" aria-label="裁剪时间轴">
        <div class="video-trim-transport">
          <button type="button" class="outline-button video-trim-play" data-trim="play" aria-label="播放选段">
            <svg class="video-trim-play-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 2.8 15 9 5 15.2Z"/></svg>
            <svg class="video-trim-pause-icon" viewBox="0 0 18 18" aria-hidden="true" hidden><path d="M4 3h3v12H4zm7 0h3v12h-3z"/></svg>
            <span>播放选段</span>
          </button>
          <output class="video-trim-play-time" aria-label="当前画面时间">00:00.000</output>
          <button type="button" class="tool-button video-trim-notes-toggle" data-trim="toggle-notes"
            aria-controls="video-trim-notes" aria-expanded="false" hidden>时间点备注</button>
          <button type="button" class="tool-button video-trim-reset" data-trim="reset">重置范围</button>
        </div>
        <div class="video-trim-axis">
          <div class="video-trim-ruler" aria-hidden="true"></div>
          <div class="video-trim-filmstrip">
            <canvas width="1440" height="144" aria-hidden="true"></canvas>
            <div class="video-trim-shade is-before"></div>
            <div class="video-trim-shade is-after"></div>
            <div class="video-trim-note-pins" aria-hidden="true"></div>
            <button type="button" role="slider" class="video-trim-selection" data-trim="move" aria-label="移动整段裁剪范围"></button>
            <button type="button" role="slider" class="video-trim-handle is-start" data-trim="start" aria-label="拖动入点"><span></span></button>
            <button type="button" role="slider" class="video-trim-handle is-end" data-trim="end" aria-label="拖动出点"><span></span></button>
            <button type="button" role="slider" class="video-trim-playhead" data-trim="head" aria-label="拖动播放位置"><span></span></button>
          </div>
        </div>
        <div class="video-trim-times">
          <label>入点 <input type="text" class="video-trim-time-input" name="start" inputmode="decimal" spellcheck="false" aria-label="入点时间"></label>
          <label>出点 <input type="text" class="video-trim-time-input" name="end" inputmode="decimal" spellcheck="false" aria-label="出点时间"></label>
          <span class="video-trim-length">选段 <output aria-label="选段时长">00:00.000</output></span>
          <span class="video-trim-hint">拖动两端调整长度，拖动中间移动整段</span>
        </div>
        <section class="video-trim-segments" aria-label="导出片段顺序">
          <div class="video-trim-segments-head">
            <button type="button" class="outline-button" data-trim="add-segment" title="从播放位置添加片段">＋ 添加片段</button>
            <output aria-label="合并时长" hidden></output>
          </div>
          <ol class="video-trim-segment-list" hidden></ol>
        </section>
        <fieldset class="video-trim-notes" id="video-trim-notes" hidden>
          <legend>时间点备注</legend>
          <ul class="video-trim-note-list"></ul>
          <div class="video-trim-note-actions">
            <span class="video-trim-note-status" role="status"></span>
            <button type="button" class="outline-button" data-trim="notes-csv">导出选段 CSV</button>
            <button type="button" class="outline-button" data-trim="notes-srt">导出选段 SRT</button>
          </div>
        </fieldset>
      </section>
      <div class="video-trim-progress" hidden>
        <progress max="1"></progress><span role="status"></span>
      </div>
      <footer class="video-trim-footer">
        <p class="video-trim-message" role="status" hidden></p>
        <div class="video-trim-settings">
          <label>格式 <select name="format" aria-label="导出格式"><option value="webm">WebM</option><option value="mp4" hidden>MP4</option></select></label>
          <label>清晰度 <select name="resolution" aria-label="导出清晰度"><option value="original">原尺寸（最高 4K）</option><option value="1080">最高 1080p</option><option value="720">最高 720p</option></select></label>
          <label>画质 <select name="quality" aria-label="导出画质"><option value="high">高画质</option><option value="standard" selected>均衡</option><option value="small">较小文件</option></select></label>
          <label class="video-trim-mute"><input type="checkbox" name="muted"> 静音</label>
        </div>
        <button type="button" class="outline-button" data-trim="cancel" hidden>取消导出</button>
        <button type="button" class="primary-button" data-trim="export">导出选段</button>
      </footer>`;
    document.body.append(dialog);

    const find = selector => dialog.querySelector(selector);
    const video = find('video');
    const stageStatus = find('.video-trim-stage-status');
    const stageNotice = find('.video-trim-stage-notice');
    const stage = find('.video-trim-stage');
    const axis = find('.video-trim-axis');
    const ruler = find('.video-trim-ruler');
    const strip = find('.video-trim-filmstrip');
    const canvas = strip.querySelector('canvas');
    const message = find('.video-trim-message');
    const progressRow = find('.video-trim-progress');
    const progress = progressRow.querySelector('progress');
    const progressStatus = progressRow.querySelector('span');
    const lengthOutput = find('.video-trim-length output');
    const playTime = find('.video-trim-play-time');
    const startInput = find('input[name=start]');
    const endInput = find('input[name=end]');
    const segmentList = find('.video-trim-segment-list');
    const mergedLength = find('.video-trim-segments-head output');
    const format = find('select[name=format]');
    const resolution = find('select[name=resolution]');
    const quality = find('select[name=quality]');
    const mute = find('input[name=muted]');
    const notesPanel = find('.video-trim-notes');
    const notesList = find('.video-trim-note-list');
    const notePins = find('.video-trim-note-pins');
    const noteStatus = find('.video-trim-note-status');
    const buttons = Object.fromEntries([...dialog.querySelectorAll('[data-trim]')].map(button => [button.dataset.trim, button]));
    const sliderKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
    let current;
    let drag;
    let seekFrame = 0;
    let playbackFrame = 0;
    let disposeProgress;

    const isActive = state => current === state && dialog.open;
    const editingLocked = state => state.saving || state.savingNotes;
    const step = state => state.frameRate > 0 ? 1 / state.frameRate : 0.04;
    const minimum = state => Math.min(state.duration, minimumRange);
    const percentage = (seconds, duration) => `${duration ? seconds / duration * 100 : 0}%`;

    function status(text, error = false) {
      message.textContent = text;
      message.hidden = !text;
      message.classList.toggle('is-error', error);
    }

    function previewStatus(text) {
      stageStatus.textContent = text;
      stageNotice.hidden = !text;
      const state = current;
      buttons['make-preview'].hidden = !state?.sessionId || !state.previewFailed || state.previewAvailable === false || !bridge.makeTrimPreview;
      buttons['make-preview'].textContent = state?.makingPreview ? '取消预览' : '生成兼容预览';
    }

    function setTicks(duration) {
      const interval = tickIntervals.find(value => value >= duration / 6) || Math.ceil(duration / 21600) * 3600;
      const marks = [0];
      for (let index = 1; index * interval < duration * 0.93; index++) marks.push(index * interval);
      if (duration) marks.push(duration);
      const labels = marks.map(seconds => {
        const label = document.createElement('span');
        label.textContent = timecode(seconds, duration < 8 && duration > 0);
        label.style.left = percentage(seconds, duration);
        return label;
      });
      ruler.replaceChildren(...labels);
    }

    function setSlider(control, value, low, high, description) {
      control.setAttribute('aria-valuemin', low.toFixed(3));
      control.setAttribute('aria-valuemax', high.toFixed(3));
      control.setAttribute('aria-valuenow', value.toFixed(3));
      control.setAttribute('aria-valuetext', description || timecode(value));
    }

    function renderPosition(state) {
      axis.style.setProperty('--trim-position', percentage(state.position, state.duration));
      playTime.value = timecode(state.position);
      setSlider(buttons.head, state.position, 0, state.duration);
    }

    function renderPlayback() {
      const playing = !video.paused && !video.ended;
      buttons.play.querySelector('.video-trim-play-icon').hidden = playing;
      buttons.play.querySelector('.video-trim-pause-icon').hidden = !playing;
      const label = playing ? '暂停' : '播放选段';
      buttons.play.querySelector('span').textContent = label;
      buttons.play.setAttribute('aria-label', label);
    }

    function inRange(segment, { seconds }) {
      return seconds >= segment.start && seconds < segment.end;
    }

    function totalLength(state) {
      return state.segments.reduce((total, { start, end }) => total + (end - start), 0);
    }

    function renderSegments(state, locked, length) {
      const count = state.segments.length;
      const multiple = count > 1;
      segmentList.hidden = mergedLength.hidden = !multiple;
      mergedLength.value = `合并顺序 · ${count} 段 · ${timecode(length)}${length > maximumDuration ? '（超过 24 小时）' : ''}`;
      buttons['add-segment'].disabled = locked || !state.metadataReady || count >= state.maximumSegments;
      buttons['add-segment'].title = count >= state.maximumSegments ? `最多 ${state.maximumSegments} 个片段` : '从播放位置添加片段';
      if (!multiple) return;
      while (segmentList.children.length > count) segmentList.lastElementChild.remove();
      while (segmentList.children.length < count) {
        const row = document.createElement('li');
        for (const [action, label] of [['select', ''], ['earlier', '↑'], ['later', '↓'], ['remove', '×']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'outline-button';
          button.dataset.segmentAction = action;
          button.textContent = label;
          row.append(button);
        }
        segmentList.append(row);
      }
      state.segments.forEach(({ start, end }, index) => {
        const row = segmentList.children[index];
        const [select, earlier, later, remove] = row.children;
        const caption = `片段 ${index + 1}`;
        row.dataset.selected = String(index === state.segmentIndex);
        select.setAttribute('aria-pressed', row.dataset.selected);
        select.textContent = `${caption}　${timecode(start)} – ${timecode(end)}`;
        select.disabled = remove.disabled = locked;
        earlier.disabled = locked || index === 0;
        later.disabled = locked || index === count - 1;
        earlier.title = `将${caption}前移`;
        later.title = `将${caption}后移`;
        remove.title = `移除${caption}`;
      });
    }

    function addSegment() {
      const state = current;
      if (!state || buttons['add-segment'].disabled) return;
      const span = clamp(state.duration / 4, minimum(state), Math.min(state.duration, 5));
      const start = clamp(state.position, 0, state.duration - span);
      state.segments.push({ start, end: Math.min(state.duration, start + span) });
      pickSegment(state, state.segments.length - 1);
      segmentList.lastElementChild.scrollIntoView({ block: 'nearest' });
    }

    function pickSegment(state, index) {
      pause();
      state.segmentIndex = index;
      status('');
      render(state);
      seekTo(state, state.start);
      (segmentList.hidden ? buttons['add-segment'] : segmentList.children[index]?.firstElementChild)?.focus({ preventScroll: true });
    }

    function changeSegments(event) {
      const button = event.target.closest('[data-segment-action]');
      const state = current;
      if (!button || button.disabled || !state || editingLocked(state)) return;
      const index = Array.prototype.indexOf.call(segmentList.children, button.parentElement);
      const selected = state.segments[state.segmentIndex];
      const action = button.dataset.segmentAction;
      if (action === 'select') return pickSegment(state, index);
      const [segment] = state.segments.splice(index, 1);
      if (action === 'remove') {
        if (selected === segment) return pickSegment(state, Math.min(index, state.segments.length - 1));
      } else {
        state.segments.splice(index + (action === 'earlier' ? -1 : 1), 0, segment);
      }
      state.segmentIndex = state.segments.indexOf(selected);
      render(state);
      (segmentList.hidden ? buttons['add-segment'] : segmentList.children[state.segmentIndex]?.firstElementChild)?.focus({ preventScroll: true });
    }

    function renderNotes(state) {
      const notes = state.duration ? state.notes.filter(note => note.seconds <= state.duration) : [];
      const button = buttons['toggle-notes'];
      button.hidden = notes.length === 0;
      button.textContent = `时间点备注 (${notes.length})`;
      const pins = document.createDocumentFragment();
      const rows = document.createDocumentFragment();
      for (const { seconds, text } of notes) {
        const label = timecode(seconds);
        const createAction = (caption, action) => {
          const control = document.createElement('button');
          control.type = 'button';
          control.className = 'outline-button';
          control.textContent = caption;
          control.setAttribute('aria-label', `${action === 'jump' ? '跳到' : caption} ${label}`);
          control.addEventListener('click', () => applyNote(state, action, seconds));
          return control;
        };
        const pin = document.createElement('span');
        pin.style.left = percentage(seconds, state.duration);
        pins.append(pin);
        const row = document.createElement('li');
        const note = document.createElement('span');
        note.textContent = text;
        const actions = document.createElement('div');
        actions.append(createAction('设为入点', 'start'), createAction('设为出点', 'end'));
        row.append(createAction(label, 'jump'), note, actions);
        rows.append(row);
      }
      notePins.replaceChildren(pins);
      notesList.replaceChildren(rows);
      if (!notes.length) setNotesOpen(false);
    }

    function setNotesOpen(open) {
      notesPanel.hidden = !open;
      buttons['toggle-notes'].setAttribute('aria-expanded', String(open));
      noteStatus.textContent = '';
    }

    function applyNote(state, action, seconds) {
      if (!isActive(state) || !state.duration || editingLocked(state)) return;
      const min = minimum(state) - 1e-7;
      if ((action === 'start' && state.end - seconds < min) ||
          (action === 'end' && seconds - state.start < min)) {
        noteStatus.textContent = '入点和出点之间至少保留 0.1 秒。';
        return;
      }
      pause();
      if (action === 'jump') seekTo(state, seconds);
      else changeRange(state, action, seconds);
      noteStatus.textContent = action === 'jump' ? `已定位到 ${timecode(seconds)}`
        : `已将${action === 'start' ? '入点' : '出点'}设为 ${timecode(seconds)}`;
    }

    async function exportRangeNotes(format) {
      const state = current;
      if (!state?.metadataReady || editingLocked(state) || !bridge.saveVideoMarkers) return;
      let duration = 0;
      const notes = [];
      for (const segment of state.segments) {
        for (const note of state.notes) {
          if (inRange(segment, note)) notes.push({ seconds: duration + (note.seconds - segment.start), text: note.text });
        }
        duration += segment.end - segment.start;
      }
      if (!notes.length) return;
      if (notes.length > 3000) {
        noteStatus.textContent = '合并片段包含超过 3000 条备注，请减少片段后导出。';
        return;
      }
      pause();
      state.savingNotes = true;
      noteStatus.textContent = '';
      render(state);
      try {
        const { id, registrationId } = state.reference;
        const result = await bridge.saveVideoMarkers({ id, registrationId, format, notes, duration });
        if (!isActive(state) || result?.cancelled) return;
        noteStatus.textContent = result?.ok ? `已导出选段 ${format.toUpperCase()} 备注。`
          : result?.message || '无法导出选段备注，请重试。';
      } catch {
        if (isActive(state)) noteStatus.textContent = '无法导出选段备注，请重试。';
      } finally {
        if (isActive(state)) {
          state.savingNotes = false;
          render(state);
          buttons[`notes-${format}`].focus({ preventScroll: true });
        }
      }
    }

    function render(state) {
      const { start, end, duration, saving, metadataReady } = state;
      const locked = editingLocked(state);
      const length = totalLength(state);
      axis.style.setProperty('--trim-start', percentage(start, duration));
      axis.style.setProperty('--trim-end', percentage(end, duration));
      axis.style.setProperty('--trim-length', percentage(end - start, duration));
      axis.dataset.ready = Boolean(duration);
      if (document.activeElement !== startInput) startInput.value = timecode(start);
      if (document.activeElement !== endInput) endInput.value = timecode(end);
      lengthOutput.value = timecode(end - start);
      setSlider(buttons.start, start, 0, Math.max(0, end - minimum(state)));
      setSlider(buttons.end, end, Math.min(duration, start + minimum(state)), duration);
      setSlider(buttons.move, start, 0, Math.max(0, duration - (end - start)), `${timecode(start)} 到 ${timecode(end)}`);
      renderPosition(state);
      renderPlayback();
      for (const control of [buttons.start, buttons.end, buttons.move, buttons.head, startInput, endInput]) {
        control.disabled = !duration || locked;
      }
      buttons.play.disabled = locked || !state.previewReady || !duration;
      buttons.reset.disabled = !duration || locked || (start === 0 && end === duration);
      buttons.reset.textContent = state.segments.length > 1 ? '重置片段' : '重置范围';
      buttons.export.disabled = locked || state.makingPreview || !metadataReady || !duration || !format.value || length > maximumDuration;
      buttons.export.textContent = state.segments.length > 1 ? '合并并导出' : '导出选段';
      renderSegments(state, locked, length);
      buttons.close.disabled = locked;
      buttons.cancel.hidden = !saving;
      buttons.cancel.disabled = state.cancelling;
      for (const control of [format, resolution, quality]) control.disabled = locked || !metadataReady;
      mute.disabled = locked || state.hasAudio === false;
      buttons['toggle-notes'].disabled = locked;
      notesPanel.disabled = locked;
      const noNotesToExport = !metadataReady || !state.segments.some(segment => state.notes.some(note => inRange(segment, note)));
      buttons['notes-csv'].disabled = buttons['notes-srt'].disabled = noNotesToExport;
    }

    function activateDuration(state, value, authoritative = false) {
      if (!(value > 0 && Number.isFinite(value)) || (state.durationProbed && !authoritative)) return;
      const previous = state.duration;
      const untouchedEnd = state.end === previous;
      state.duration = value;
      state.durationProbed = authoritative;
      state.end = untouchedEnd ? value : clamp(state.end, minimum(state), value);
      state.start = clamp(state.start, 0, state.end - minimum(state));
      state.position = clamp(state.position, 0, value);
      if (state.initialPosition !== null) {
        state.position = clamp(state.initialPosition, 0, value);
        state.pendingSeek = state.position;
        state.initialPosition = null;
      }
      setTicks(value);
      if (value !== previous) renderNotes(state);
      render(state);
    }

    function syncSeek() {
      seekFrame = 0;
      const state = current;
      if (!state?.previewReady || state.pendingSeek === null || video.seeking) return;
      const length = Number.isFinite(video.duration) ? video.duration : state.duration;
      const time = clamp(state.pendingSeek, 0, Math.max(0, length - 0.001));
      state.pendingSeek = null;
      if (Math.abs(video.currentTime - time) > 0.001) video.currentTime = time;
    }

    function seekTo(state, seconds) {
      state.position = clamp(seconds, 0, state.duration);
      state.pendingSeek = state.position;
      renderPosition(state);
      if (state.previewReady && !seekFrame) seekFrame = requestAnimationFrame(syncSeek);
    }

    function changeRange(state, type, value, span = state.end - state.start) {
      if (type === 'start') {
        state.start = clamp(value, 0, Math.max(0, state.end - minimum(state)));
      } else if (type === 'end') {
        state.end = clamp(value, Math.min(state.duration, state.start + minimum(state)), state.duration);
      } else {
        state.start = clamp(value, 0, Math.max(0, state.duration - span));
        state.end = state.start + span;
      }
      render(state);
      seekTo(state, type === 'end' ? state.end : state.start);
    }

    function pause() {
      video.pause();
      cancelAnimationFrame(playbackFrame);
      playbackFrame = 0;
    }

    async function togglePlayback() {
      const state = current;
      if (buttons.play.disabled || !state) return;
      if (!video.paused) {
        pause();
        return;
      }
      try {
        const position = state.position < state.start || state.position >= state.end - step(state) / 2
          ? state.start : state.position;
        seekTo(state, position);
        if (video.seeking) await waitForMedia(video, 'seeked', () => !video.seeking, state.abort.signal);
        if (!isActive(state) || editingLocked(state) || drag) return;
        syncSeek();
        await video.play();
      } catch {
        if (isActive(state) && !state.saving) status('无法播放视频，可继续选择时间并导出。', true);
      }
    }

    function syncPlayback() {
      playbackFrame = 0;
      const state = current;
      if (!state?.previewReady || video.paused) return;
      const time = video.currentTime;
      if (time >= state.end - 0.002 || video.ended) {
        pause();
        seekTo(state, state.end);
      } else {
        state.position = clamp(time, 0, state.duration);
        renderPosition(state);
        playbackFrame = requestAnimationFrame(syncPlayback);
      }
    }

    function timeAt(state, clientX, bounds) {
      return clamp((clientX - bounds.left) / bounds.width, 0, 1) * state.duration;
    }

    function beginDrag(event) {
      const state = current;
      if (!state?.duration || editingLocked(state) || drag || event.button !== 0 || !event.isPrimary) return;
      const bounds = strip.getBoundingClientRect();
      if (!bounds.width) return;
      event.preventDefault();
      const handle = event.target.closest('[data-trim]');
      const type = handle?.dataset.trim ?? 'head';
      if (handle) handle.focus({ preventScroll: true });
      pause();
      drag = { pointer: event.pointerId, type, bounds, x: event.clientX, start: state.start, end: state.end, moved: false,
        offset: handle && type === 'head' ? timeAt(state, event.clientX, bounds) - state.position : 0 };
      axis.setPointerCapture(event.pointerId);
      axis.dataset.dragging = type;
      if (type === 'head' && !handle) seekTo(state, timeAt(state, event.clientX, bounds));
    }

    function continueDrag(event) {
      const state = current;
      if (!state || drag?.pointer !== event.pointerId) return;
      const distance = event.clientX - drag.x;
      if (drag.type === 'move' && !drag.moved && Math.abs(distance) < 4) return;
      drag.moved = true;
      if (drag.type === 'head') {
        seekTo(state, timeAt(state, event.clientX, drag.bounds) - drag.offset);
      } else {
        const delta = distance / drag.bounds.width * state.duration;
        const origin = drag.type === 'end' ? drag.end : drag.start;
        changeRange(state, drag.type, origin + delta, drag.end - drag.start);
      }
    }

    function endDrag(event) {
      const state = current;
      if (!state || drag?.pointer !== event.pointerId) return;
      if (event.type === 'pointerup') {
        if (drag.type === 'move' && !drag.moved && Math.abs(event.clientX - drag.x) < 4) {
          seekTo(state, timeAt(state, event.clientX, drag.bounds));
        } else if (drag.moved || Math.abs(event.clientX - drag.x) >= 1) {
          continueDrag(event);
        }
      }
      drag = null;
      delete axis.dataset.dragging;
      if (axis.hasPointerCapture(event.pointerId)) axis.releasePointerCapture(event.pointerId);
    }

    function handleKey(event) {
      const state = current;
      const type = event.currentTarget.dataset.trim;
      if (!state?.duration || editingLocked(state) || !sliderKeys.has(event.key)) return;
      event.preventDefault();
      pause();
      const duration = state.duration;
      let value = state[type === 'move' ? 'start' : type === 'head' ? 'position' : type];
      if (event.key === 'Home') value = type === 'end' ? state.start + minimum(state) : 0;
      else if (event.key === 'End') value = duration;
      else {
        const forward = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key);
        const skip = event.key.startsWith('Page') ? Math.max(step(state), duration / 10) : event.shiftKey ? 1 : step(state);
        value += forward ? skip : -skip;
      }
      if (type === 'head') seekTo(state, value);
      else changeRange(state, type, value);
    }

    function commitTime(event) {
      const state = current;
      const input = event.currentTarget;
      if (!state?.duration || editingLocked(state)) return;
      const seconds = parseTimecode(input.value);
      if (Number.isFinite(seconds)) {
        pause();
        changeRange(state, input.name, seconds);
        status('');
      } else status('请输入时间，例如 00:04.500 或 4.5 秒。', true);
      input.value = timecode(state[input.name]);
    }

    async function drawFilmstrip(state, source) {
      const decoder = document.createElement('video');
      decoder.muted = true;
      decoder.preload = 'auto';
      decoder.src = source;
      const { signal } = state.abort;
      const context = canvas.getContext('2d');
      let drawn = false;
      try {
        if (!context) return;
        await waitForMedia(decoder, 'loadeddata', () => decoder.readyState >= 2, signal, 8000);
        const sourceDuration = Math.min(state.duration, decoder.duration);
        if (!(sourceDuration > 0)) return;
        const width = canvas.width / frameCount;
        for (let index = 0; index < frameCount && isActive(state) && !signal.aborted; index++) {
          const time = sourceDuration * (index + 0.5) / frameCount;
          decoder.currentTime = time;
          await waitForMedia(decoder, 'seeked', () => !decoder.seeking && decoder.readyState >= 2, signal);
          coverFrame(context, decoder, index * width, width, canvas.height);
          drawn = true;
          strip.dataset.frames = String(index + 1);
          if (index === 0) canvas.hidden = false;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } catch {
        if (isActive(state) && !drawn) canvas.hidden = true;
      } finally { releaseVideo(decoder); }
    }

    async function requestPreview(state) {
      if (!isActive(state) || !state.sessionId || state.makingPreview || state.previewAvailable === false || !bridge.makeTrimPreview) return;
      state.makingPreview = true;
      previewStatus('正在生成兼容预览…');
      render(state);
      let outcome = '当前格式无法直接预览。你仍可按时间选择并导出。';
      try {
        const result = await bridge.makeTrimPreview(state.sessionId);
        if (!isActive(state)) return;
        if (result?.cancelled || result?.canceled) {
          outcome = '已取消预览。你仍可按时间选择并导出。';
          return;
        }
        const source = safeURL(result?.previewURL);
        if (!result?.ok || !source || source === state.source) throw new Error('预览不可用');
        await updateMedia(state, source);
      } catch {
        outcome = '暂时无法生成兼容预览。你仍可按时间选择并导出。';
      } finally {
        if (isActive(state)) {
          state.makingPreview = false;
          progressRow.hidden = true;
          if (!state.previewReady) previewStatus(outcome);
          render(state);
        }
      }
    }

    async function updateMedia(state, source) {
      if (!source || !isActive(state)) return;
      state.source = source;
      state.previewReady = false;
      previewStatus('正在读取视频画面…');
      video.src = source;
      video.load();
      try {
        await waitForMedia(video, 'loadeddata', () => video.readyState >= 2 && video.videoWidth > 0,
          state.abort.signal, 12_000);
        if (!isActive(state) || state.source !== source) return;
        state.previewReady = true;
        state.previewFailed = false;
        activateDuration(state, video.duration);
        previewStatus('');
        stage.dataset.ready = 'true';
        render(state);
        if (state.pendingSeek !== null) syncSeek();
        void drawFilmstrip(state, source);
      } catch {
        if (!isActive(state) || state.source !== source) return;
        const fallback = state.fallback;
        if (fallback && fallback !== source) void updateMedia(state, fallback);
        else {
          state.previewFailed = true;
          previewStatus('当前格式无法直接预览。你仍可按时间选择并导出。');
        }
      }
    }

    function showProgress(update = {}) {
      const state = current;
      if (!state || !dialog.open || (update.sessionId && state.sessionId && update.sessionId !== state.sessionId)) return;
      if (!state.metadataReady && update.sessionId) state.preparingSessionId = update.sessionId;
      if (!state.saving && state.metadataReady && update.phase !== 'preview') return;
      progressRow.hidden = false;
      if (state.cancelling) return;
      const fraction = Number.isFinite(update.fraction) ? update.fraction
        : Number.isFinite(update.progress) ? update.progress : null;
      if (fraction === null) progress.removeAttribute('value');
      else progress.value = clamp(fraction, 0, 1);
      const label = { preparing: '正在准备原件…', copying: '正在读取原件…', probing: '正在读取时长…',
        encoding: '正在导出选段…', verifying: '正在检查导出文件…', publishing: '正在保存文件…', preview: '正在生成兼容预览…' }[update.phase];
      progressStatus.textContent = update.message || (fraction === null ? (label || '正在准备导出…')
        : `${label || '正在导出选段…'} ${Math.round(clamp(fraction, 0, 1) * 100)}%`);
    }

    async function runExport() {
      const state = current;
      if (!state || buttons.export.disabled) return;
      pause();
      state.saving = true;
      state.cancelling = false;
      status('');
      progressRow.hidden = true;
      render(state);
      try {
        const result = await bridge.exportTrimmedVideo({ ...state.reference, sessionId: state.sessionId,
          segments: state.segments, format: format.value, resolution: resolution.value, quality: quality.value, muted: mute.checked });
        if (!isActive(state)) return;
        if (result?.ok && !result.cancelled && !result.canceled) {
          state.saving = false;
          dialog.close();
          notify(result.message || (state.segments.length > 1 ? `已合并导出 ${state.segments.length} 个片段。` : '已导出视频选段。'));
        } else if (!result?.cancelled && !result?.canceled) {
          status(result?.message || result?.error || '视频导出未完成，请重试。', true);
        }
      } catch (error) {
        if (isActive(state)) status(error.message || '视频导出未完成，请重试。', true);
      } finally {
        if (isActive(state)) {
          state.saving = false;
          state.cancelling = false;
          progressRow.hidden = true;
          render(state);
          buttons.export.focus();
        }
      }
    }

    async function stopExport() {
      const state = current;
      if (!state?.saving || state.cancelling) return;
      state.cancelling = true;
      progressRow.hidden = false;
      progress.removeAttribute('value');
      progressStatus.textContent = '正在取消导出…';
      render(state);
      try {
        const result = await bridge.cancelVideoTrim(state.sessionId);
        if (isActive(state) && result?.ok === false) throw new Error(result.message);
      } catch (error) {
        if (isActive(state)) {
          state.cancelling = false;
          status(error.message || '暂时无法取消导出。', true);
          render(state);
        }
      }
    }

    function reset() {
      const state = current;
      if (!state || buttons.reset.disabled) return;
      pause();
      state.start = 0;
      state.end = state.duration;
      status('');
      render(state);
      seekTo(state, 0);
    }

    function releaseSession(sessionId) {
      if (sessionId && bridge.releaseTrimVideo) void Promise.resolve(bridge.releaseTrimVideo(sessionId)).catch(() => {});
    }

    async function open(asset, { startAt, notes = [] } = {}) {
      if (!asset || (current && editingLocked(current))) return;
      dispose();
      const state = { abort: new AbortController(), reference: { id: asset.sourceAssetId, registrationId: asset.sourceLibraryId,
        revision: asset.sourceRevision }, duration: 0, position: 0, frameRate: 0, pendingSeek: null,
        segments: [{ start: 0, end: 0 }], segmentIndex: 0, maximumSegments: 1,
        get start() { return this.segments[this.segmentIndex].start; },
        set start(value) { this.segments[this.segmentIndex].start = value; },
        get end() { return this.segments[this.segmentIndex].end; },
        set end(value) { this.segments[this.segmentIndex].end = value; },
        initialPosition: Number.isFinite(startAt) ? Math.max(0, startAt) : null,
        previewReady: false, saving: false, cancelling: false, metadataReady: false,
        notes: [...notes].sort((a, b) => a.seconds - b.seconds), savingNotes: false };
      current = state;
      find('.video-trim-name').textContent = asset.name || '';
      find('.video-trim-name').title = asset.name || '';
      video.removeAttribute('poster');
      video.muted = mute.checked = false;
      format.value = 'webm';
      format.querySelector('[value=mp4]').hidden = true;
      resolution.value = 'original';
      quality.value = 'standard';
      stage.dataset.ready = 'false';
      video.hidden = false;
      canvas.hidden = true;
      delete strip.dataset.frames;
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      status('');
      previewStatus('正在读取视频…');
      progressRow.hidden = true;
      setTicks(0);
      setNotesOpen(false);
      renderNotes(state);
      if (!dialog.open) dialog.showModal();
      activateDuration(state, asset.duration);
      render(state);
      disposeProgress = bridge.onVideoTrimProgress?.(showProgress);
      void Promise.resolve().then(() => getPoster?.(asset)).then(value => {
        const poster = safeURL(value);
        if (isActive(state) && poster) video.poster = poster;
      }).catch(() => {});
      void Promise.resolve().then(() => getVideo(asset)).then(value => {
        if (!isActive(state)) return;
        const source = safeURL(value) || state.fallback;
        if (source) return updateMedia(state, source);
      }).catch(() => {});

      try {
        const result = await bridge.probeTrimVideo(state.reference);
        if (!isActive(state)) {
          releaseSession(result?.sessionId);
          return;
        }
        if (!result?.ok) throw new Error(result?.message || '不能读取视频时长，请检查原件。');
        state.frameRate = Number.isFinite(result.frameRate) ? Math.max(0, result.frameRate) : 0;
        state.sessionId = result.sessionId;
        state.hasAudio = result.hasAudio;
        state.maximumSegments = result.maximumSegments || 1;
        state.previewAvailable = result.previewAvailable;
        const supported = Array.isArray(result.formats) ? result.formats : ['webm'];
        for (const option of format.options) option.hidden = !supported.includes(option.value);
        format.value = supported.find(value => ['webm', 'mp4'].includes(value)) || '';
        state.metadataReady = true;
        activateDuration(state, result.duration, true);
        state.fallback = safeURL(result.previewURL);
        if (!state.source || state.previewFailed) {
          if (state.fallback) void updateMedia(state, state.fallback);
          else {
            state.previewFailed = true;
            previewStatus('当前格式无法直接预览。你仍可按时间选择并导出。');
          }
        }
        progressRow.hidden = true;
        if (!state.duration) status('未读到有效时长，请换一个视频原件。', true);
        render(state);
      } catch (error) {
        if (!isActive(state)) return;
        progressRow.hidden = true;
        if (!state.source) previewStatus('无法读取视频画面。');
        status(error.message || '无法裁剪这个视频。', true);
      }
    }

    function dispose() {
      current?.abort.abort();
      releaseSession(current?.sessionId || current?.preparingSessionId);
      current = undefined;
      if (drag && axis.hasPointerCapture(drag.pointer)) axis.releasePointerCapture(drag.pointer);
      drag = undefined;
      delete axis.dataset.dragging;
      disposeProgress?.();
      disposeProgress = undefined;
      cancelAnimationFrame(seekFrame);
      seekFrame = 0;
      pause();
      releaseVideo(video);
    }

    dialog.addEventListener('cancel', event => {
      if (current && editingLocked(current)) event.preventDefault();
    });
    dialog.addEventListener('close', () => { if (!dialog.open) dispose(); });
    buttons.close.addEventListener('click', () => dialog.close());
    buttons.reset.addEventListener('click', reset);
    buttons['add-segment'].addEventListener('click', addSegment);
    segmentList.addEventListener('click', changeSegments);
    buttons['toggle-notes'].addEventListener('click', () => setNotesOpen(notesPanel.hidden));
    buttons['notes-csv'].addEventListener('click', () => void exportRangeNotes('csv'));
    buttons['notes-srt'].addEventListener('click', () => void exportRangeNotes('srt'));
    buttons.play.addEventListener('click', () => void togglePlayback());
    buttons.cancel.addEventListener('click', () => void stopExport());
    buttons.export.addEventListener('click', () => void runExport());
    buttons['make-preview'].addEventListener('click', () => {
      const state = current;
      if (!state?.sessionId || editingLocked(state)) return;
      if (state.makingPreview) void Promise.resolve(bridge.cancelVideoTrim(state.sessionId)).catch(() => {});
      else void requestPreview(state);
    });
    mute.addEventListener('change', () => { video.muted = mute.checked; });
    axis.addEventListener('pointerdown', beginDrag);
    axis.addEventListener('pointermove', continueDrag);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) axis.addEventListener(type, endDrag);
    for (const control of [buttons.start, buttons.end, buttons.move, buttons.head]) control.addEventListener('keydown', handleKey);
    for (const field of [startInput, endInput]) {
      field.addEventListener('change', commitTime);
      field.addEventListener('keydown', event => { if (event.key === 'Enter') field.blur(); });
    }
    video.addEventListener('playing', () => {
      renderPlayback();
      if (!playbackFrame) playbackFrame = requestAnimationFrame(syncPlayback);
    });
    video.addEventListener('pause', renderPlayback);
    video.addEventListener('seeked', () => {
      if (current?.pendingSeek !== null && !seekFrame) seekFrame = requestAnimationFrame(syncSeek);
    });
    video.addEventListener('ended', () => {
      const state = current;
      if (state?.previewReady) seekTo(state, state.end);
      renderPlayback();
    });

    return { open };
  };
})();
