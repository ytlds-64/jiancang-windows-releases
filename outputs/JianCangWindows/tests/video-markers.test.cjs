'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { formatVideoMarkers, writeVideoMarkers } = require('../video-markers.cjs');

test('orders CSV markers precisely, quotes newlines, and escapes spreadsheet formulas', () => {
  const csv = formatVideoMarkers([
    { seconds: 61.527, text: '第二条,\n核对“开场”' },
    { seconds: 1.013, text: '=1+1 "保持原文"' },
  ], 'csv');
  assert.equal(csv, `\uFEFF时间码,秒数,备注\r\n00:00:01.013,1.013,"'=1+1 ""保持原文"""\r\n00:01:01.527,61.527,"第二条,\r\n核对“开场”"\r\n`);
});

test('SRT markers share a cue at the same millisecond and finish at the following marker or end of the video', () => {
  const subtitles = formatVideoMarkers([
    { seconds: 1.56, text: '第一行\n\n<第二行>' },
    { seconds: 1.56, text: '同时点备注' },
    { seconds: 2, text: '尾段&原注' },
  ], 'srt', 3.2);
  assert.equal(subtitles, '1\r\n00:00:01,560 --> 00:00:02,000\r\n第一行\r\n&lt;第二行&gt;\r\n同时点备注\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,200\r\n尾段&amp;原注\r\n\r\n');
  assert.throws(() => formatVideoMarkers([{ seconds: Infinity, text: '不合法' }], 'srt'), /格式无效/);
});

test('marker exports refuse library destinations and never overwrite a selected file', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-marker-test-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const canonical = await fs.realpath(scratch);
  const library = path.join(canonical, '素材库');
  await fs.mkdir(library);
  const options = { notes: [{ seconds: 0.5, text: '样片开场' }], format: 'srt', protectedRoots: [library] };
  await assert.rejects(writeVideoMarkers({ ...options, target: path.join(library, 'protected.srt') }), /素材库以外/);
  const target = path.join(canonical, '测试.srt');
  await writeVideoMarkers({ ...options, target });
  const before = await fs.readFile(target);
  await assert.rejects(writeVideoMarkers({ ...options, target, notes: [{ seconds: 1, text: '不得覆盖' }] }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(target), before);
});
