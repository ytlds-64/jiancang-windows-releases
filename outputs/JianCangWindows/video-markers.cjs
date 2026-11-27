'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { validateExportTarget } = require('./original-file.cjs');

const maximumSeconds = 14 * 24 * 60 * 60;

function at(milliseconds, decimal) {
  const whole = Math.floor(milliseconds / 1000);
  const [hours, minutes, seconds] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(value => String(value).padStart(2, '0'));
  return `${hours}:${minutes}:${seconds}${decimal}${String(milliseconds % 1000).padStart(3, '0')}`;
}

function sheetField(value) {
  const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function subtitleText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\r\n');
}

function formatVideoMarkers(input, format, duration) {
  if (!Array.isArray(input) || !input.length || input.length > 3000 || !['csv', 'srt'].includes(format)) {
    throw new Error('没有可导出的视频备注，或格式不受支持。');
  }
  const notes = input.map(note => {
    if (typeof note?.text !== 'string' || note.text.length > 500 || !Number.isFinite(note.seconds) ||
        note.seconds < 0 || note.seconds > maximumSeconds) throw new Error('有一条视频备注格式无效。');
    const text = note.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ').trim();
    if (!text) throw new Error('有一条视频备注没有正文。');
    return { time: Math.round(note.seconds * 1000), text };
  }).sort((left, right) => left.time - right.time);
  if (format === 'csv') {
    return `\uFEFF时间码,秒数,备注\r\n${notes.map(({ time, text }) =>
      `${at(time, '.')},${(time / 1000).toFixed(3)},${sheetField(text.replaceAll('\n', '\r\n'))}`).join('\r\n')}\r\n`;
  }
  const endOfVideo = Number.isFinite(duration) && duration > 0 && duration <= maximumSeconds
    ? Math.max(1, Math.round(duration * 1000)) : Number.POSITIVE_INFINITY;
  const grouped = new Map();
  for (const note of notes) {
    const time = Math.min(note.time, endOfVideo - 1);
    const text = subtitleText(note.text);
    grouped.set(time, grouped.has(time) ? `${grouped.get(time)}\r\n${text}` : text);
  }
  const entries = [...grouped];
  return entries.map(([start, text], index) => {
    const end = Math.min(start + 3000, entries[index + 1]?.[0] ?? Number.POSITIVE_INFINITY, endOfVideo);
    return `${index + 1}\r\n${at(start, ',')} --> ${at(end, ',')}\r\n${text}\r\n\r\n`;
  }).join('');
}

async function writeVideoMarkers({ notes, format, duration, target, protectedRoots }) {
  const content = formatVideoMarkers(notes, format, duration);
  const destination = await validateExportTarget(target, protectedRoots, '请选择素材库以外的文件夹保存视频备注。');
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.jiancang-markers-'));
  try {
    const draft = path.join(staging, `markers.${format}`);
    await fs.writeFile(draft, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.copyFile(draft, destination, constants.COPYFILE_EXCL);
  } finally { await fs.rm(staging, { force: true, recursive: true }); }
}

module.exports = { formatVideoMarkers, writeVideoMarkers };
