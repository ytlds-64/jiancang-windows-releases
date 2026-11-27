'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { readEagleLibrary, resolveEagleReadingDirectory } = require('../eagle-library.cjs');
const { exportReadOnly, openContainedFile, withReadOnlyThumbnailFile } = require('../original-file.cjs');

async function fixture(t, header = { id: 'Eagle-ID', name: '灵感', folders: [] }) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-eagle-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, '灵感.library');
  await fs.mkdir(path.join(root, 'images'), { recursive: true });
  await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify(header));
  return { temporary, root, images: path.join(root, 'images') };
}

async function addItem(images, id, metadata, files = {}) {
  const directory = path.join(images, `${id}.info`);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ id, ...metadata }));
  for (const [filename, bytes] of Object.entries(files)) await fs.writeFile(path.join(directory, filename), bytes);
  return directory;
}

test('reads nested folders, original paths, thumbnails, metadata, links and Eagle trash', async t => {
  const header = { id: 'Eagle-ID', name: '灵感', folders: [{ id: 'concept', name: '风格', iconColor: 'blue',
    children: [{ id: 'reference', name: '参考' }] }] };
  const { root, images } = await fixture(t, header);
  const portrait = await addItem(images, 'P001', {
    name: '竖版.png', ext: 'PNG', width: 900, height: 1400, btime: 481000000,
    folders: ['reference', 'reference', 'missing'], star: 4, annotation: '参考构图',
    tags: ['棚拍', '棚拍', 8], url: 'https://example.com/reference',
  }, { '竖版.png': 'portrait-image', '竖版_thumbnail.png': 'thumb' });
  await addItem(images, 'V001', { name: '视频', ext: 'mp4', width: 1920, height: 1080, duration: 14.25 }, {
    '不同名称的视频.mp4': 'video', '视频_thumbnail.jpg': 'one poster',
  });
  await addItem(images, 'L001', { name: '链接', ext: 'url', url: 'https://example.com/' });
  await addItem(images, 'T001', { isDeleted: 'true', name: '删掉的图', ext: 'jpg' });

  const library = await readEagleLibrary(root);
  assert.equal(library.directoryName, '灵感');
  assert.deepEqual(library.warnings, []);
  assert.equal(library.pathIndependentIdentity, true);
  assert.deepEqual(library.collections.map(({ id, parentId, color }) => [id, parentId, color]),
    [['concept', null, '527FA7'], ['reference', 'concept', '46786B']]);
  const asset = library.assets.find(item => item.name === '竖版.png');
  assert.equal(asset.kind, 'image');
  assert.deepEqual([asset.width, asset.height], [900, 1400]);
  assert.deepEqual(asset.collectionIds, ['reference']);
  assert.deepEqual(asset.tags, ['棚拍']);
  assert.equal(asset.note, '参考构图');
  assert.equal(asset.rating, 4);
  assert.equal(asset.sourceURL, 'https://example.com/reference');
  assert.equal(asset.available, true);
  assert.equal(library.originals.get(asset.id), path.join(portrait, '竖版.png'));
  assert.equal(library.sourceThumbnails.get(asset.id).file, path.join(portrait, '竖版_thumbnail.png'));
  assert.equal(library.assets.find(item => item.kind === 'video').thumbnailAvailable, true);
  assert.equal(library.assets.find(item => item.kind === 'video').duration, 14.25);
  assert.equal(asset.duration, null);
  assert.equal(library.assets.find(item => item.kind === 'link').available, false);
  assert.equal(library.assets.find(item => item.trashed).name, '删掉的图');
});

test('does not expose an unsafe, ambiguous or partly synced Eagle original', async t => {
  const { temporary, root, images } = await fixture(t);
  const outside = path.join(temporary, 'private.jpg');
  await fs.writeFile(outside, 'private original');
  const linked = await addItem(images, 'PAIR', { name: '想看的', ext: 'jpg' });
  await fs.symlink(outside, path.join(linked, '想看的.jpg'));
  await fs.symlink(linked, path.join(images, 'alias.info'), 'dir');
  await addItem(images, 'BAD', { id: 'DIFFERENT', name: '错误的' }, { 'private.jpg': 'not an original' });
  await addItem(images, 'AMB', { name: '重名', ext: 'jpg' }, { 'one.jpg': 'one', 'two.jpg': 'two' });
  await addItem(images, 'SIZE', { name: '未下载完', ext: 'jpg', size: 20 }, { '未下载完.jpg': 'short' });
  const library = await readEagleLibrary(root);
  assert.equal(library.assets.length, 3);
  assert.equal(library.originals.size, 0);
  assert.match(library.warnings.join('\n'), /2 份 Eagle 素材的目录信息/);
  assert.match(library.warnings.join('\n'), /3 份 Eagle 原件/);
  assert.equal(library.readingIssues.total, 5);
  const issues = new Map(library.readingIssues.entries.map(issue => [issue.itemId, issue]));
  assert.equal(issues.get('BAD').reason, 'metadata-id');
  assert.equal(issues.get('BAD').path, 'images/BAD.info/metadata.json');
  assert.equal(issues.get('alias').reason, 'directory-type');
  assert.equal(issues.get('PAIR').reason, 'unsafe-path');
  assert.equal(issues.get('AMB').reason, 'original-ambiguous');
  assert.equal(issues.get('SIZE').reason, 'original-incomplete');
  assert.equal(await resolveEagleReadingDirectory(root, issues.get('BAD').directory), path.join(images, 'BAD.info'));
  await assert.rejects(resolveEagleReadingDirectory(root, 'images/alias.info'));
  await assert.rejects(resolveEagleReadingDirectory(root, 'images/../metadata.json'));
  await assert.rejects(openContainedFile(images, path.join(linked, '想看的.jpg')));
});

test('copies an Eagle original without writing into any registered library', async t => {
  const { temporary, root, images } = await fixture(t);
  const sourceFiles = await addItem(images, 'P002', { name: '名', ext: 'png' }, { '名.png': 'source bytes' });
  const source = path.join(sourceFiles, '名.png');
  const target = path.join(temporary, '副本.png');
  const protection = [root];
  await exportReadOnly(images, source, 12, target, protection);
  assert.equal(await fs.readFile(target, 'utf8'), 'source bytes');
  await assert.rejects(exportReadOnly(images, source, 12, target, protection), { code: 'EEXIST' });
  await assert.rejects(exportReadOnly(images, source, 12, path.join(root, 'extra.png'), protection), /素材库以外/);
  const scratch = await withReadOnlyThumbnailFile(images, source, 12, undefined, async file => {
    assert.equal(await fs.readFile(file, 'utf8'), 'source bytes');
    return file;
  });
  await assert.rejects(fs.access(scratch));
  assert.equal(await fs.readFile(source, 'utf8'), 'source bytes');
});
