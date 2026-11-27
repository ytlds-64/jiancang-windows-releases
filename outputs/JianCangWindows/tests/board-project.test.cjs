'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readBoardProject, writeBoardExport, projectExtension } = require('../board-export.cjs');

test('writes editable board references without copying original paths, and validates imported projects', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-board-project-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filename = path.join(directory, `选片.${projectExtension}`);
  const first = {
    id: '1'.repeat(64), registrationId: 'source-registration', libraryId: 'stable-library',
    title: '海边照片', source: '图库', note: '  留作参考\n保持原样  ',
  };
  const second = { ...first, id: '2'.repeat(64), libraryId: null, note: '' };
  const project = { name: '选片', entries: [{ ...first, path: 'C:\\Private\\original.png' }, second] };
  const parameters = { target: filename, format: projectExtension, project };
  await writeBoardExport(parameters);
  assert.deepEqual(await readBoardProject(filename), { format: 'jiancang-board', version: 1, name: '选片', entries: [first, second] });
  await assert.rejects(writeBoardExport(parameters), { code: 'EEXIST' });
  await assert.rejects(writeBoardExport({ ...parameters, protectedRoots: [directory] }), /素材库以外/);

  const invalid = path.join(directory, 'invalid.jiancangboard');
  await fs.writeFile(invalid, JSON.stringify({ format: 'jiancang-board', version: 1, name: '选片', entries: [first, first] }));
  await assert.rejects(readBoardProject(invalid), /格式有误/);
  await fs.writeFile(invalid, Buffer.alloc(512 * 1024 + 1));
  await assert.rejects(readBoardProject(invalid), /文件过大/);
});

test('round-trips iOS board references with and without a shared library', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-board-ios-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const mobileProject = {
    format: 'jiancang-board',
    version: 1,
    name: '灯光参考',
    entries: [
      {
        id: 'c'.repeat(64),
        registrationId: 'jiancang-ios',
        libraryId: 'bbcb3804-de04-460d-8a6a-52c91ad9b7dc',
        title: '手机参考 🌅',
        source: '见藏',
        note: '  调整侧光\n留作参考  ',
      },
      {
        id: 'a'.repeat(64),
        registrationId: 'jiancang-ios',
        title: '另一张参考',
        source: '见藏',
        note: '保留这张的备注 📌',
      },
    ],
  };
  const mobileFile = path.join(directory, `iOS.${projectExtension}`);
  const desktopFile = path.join(directory, `Windows.${projectExtension}`);
  await fs.writeFile(mobileFile, JSON.stringify(mobileProject));

  const imported = await readBoardProject(mobileFile);
  const [shared, local] = mobileProject.entries;
  assert.deepEqual(imported, {
    ...mobileProject,
    entries: [shared, { ...local, libraryId: null }],
  });

  const reordered = { ...imported, entries: [imported.entries[1], imported.entries[0]] };
  await writeBoardExport({ target: desktopFile, format: projectExtension, project: reordered });
  assert.deepEqual(await readBoardProject(desktopFile), reordered);
});
