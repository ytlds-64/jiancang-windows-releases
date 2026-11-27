'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { planStructuredExport, runStructuredExport } = require('../structured-export.cjs');
const { exportReadOnly, exportVerified } = require('../original-file.cjs');
const { createHash } = require('node:crypto');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-structure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  return { root, output };
}

function library(registrationId, directoryName, collections = [], root = '') {
  return { registrationId, publicLibrary: { directoryName, collections }, root };
}

function item(source, name, extras = {}, available = true) {
  const asset = { name, extension: 'png', tags: [], collectionIds: [], ...extras };
  return { name, extension: asset.extension, available, original: { asset, library: source } };
}

function folder(id, name, parentId = null) { return { id, name, parentId }; }

test('uses deepest membership with stable ties and resolves case-insensitive folder, file and library aliases', async t => {
  const { output } = await workspace(t);
  const first = library('01', '项目', [folder('main','版式'), folder('a','CON','main'), folder('b','_Con','main')]);
  const second = library('02', '项目', [folder('a','版式')]);
  const rows = [item(second, '相同', { collectionIds:['a'] }), item(first,'海报', { collectionIds:['b','main','a'] }),
    item(first,'海报', { collectionIds:['a'] }), item(first,'照片', { collectionIds:['b'] })];
  const options = { layout: 'collections' };
  const plan = planStructuredExport(rows, options);
  assert.deepEqual(plan, { total:4, available:4, unavailable:0, folderCount:3, examples:[
    { name:'相同', folder:'项目 (2)/版式' }, { name:'海报', folder:'项目/版式/_CON' }, { name:'照片', folder:'项目/版式/_Con (2)' },
  ] });
  const result = await runStructuredExport({ items:rows, options, destination:output,
    copy:(source, destination) => fs.writeFile(destination, source.name, { flag:'wx' }),
  });
  assert.equal(result.written,4);
  assert.deepEqual(await fs.readdir(path.join(result.directory,'项目','版式','_CON')), ['海报 (2).png','海报.png']);
  assert.deepEqual(await fs.readdir(path.join(result.directory,'项目 (2)','版式')), ['相同.png']);
});

test('exports secure original copies and an optional BOM CSV with safe cells, actual paths and failed rows', async t => {
  const { root, output } = await workspace(t);
  const syncRoot = path.join(root,'library');
  const eagleRoot = path.join(root,'library.library');
  await fs.mkdir(path.join(syncRoot,'blobs'),{ recursive:true });
  await fs.mkdir(path.join(eagleRoot,'images'),{ recursive:true });
  const firstFile = path.join(syncRoot,'blobs','source.csv');
  const secondFile = path.join(eagleRoot,'images','source.png');
  const firstBytes = Buffer.from('untouched original list');
  const secondBytes = Buffer.from('untouched Eagle image');
  await fs.writeFile(firstFile,firstBytes);
  await fs.writeFile(secondFile,secondBytes);
  const rows = [item(library('01','Sync',[],syncRoot),'素材清单',{
    extension:'csv', byteCount:firstBytes.length, id:createHash('sha256').update(firstBytes).digest('hex'),
    note:'\t＝1+1\r\n原始 "备注"', sourceURL:'https://example.test/example', tags:['摄影','导出'],
  }), item(library('02','Eagle',[],eagleRoot),'🎞'.repeat(150),{byteCount:secondBytes.length}),
  item(library('01','Sync',[],syncRoot),'不可用',{},false)];
  const copy = (source,destination,roots) => source.original.library.root === syncRoot
    ? exportVerified(syncRoot,firstFile,source.original.asset,destination,roots)
    : exportReadOnly(path.dirname(secondFile),secondFile,secondBytes.length,destination,roots);
  const first = await runStructuredExport({ items:rows, options:{layout:'flat',includeMetadata:true}, destination:output,
    libraryRoots:[syncRoot,eagleRoot], copy,
  });
  assert.equal(first.written,2);
  assert.match(first.failed[0].message,/原件暂不可用/);
  const files = await fs.readdir(first.directory);
  assert.ok(files.every(name=>Buffer.byteLength(name)<=240));
  assert.ok(files.includes('素材清单 (2).csv'));
  assert.deepEqual(await fs.readFile(path.join(first.directory,'素材清单 (2).csv')),firstBytes);
  const csv = await fs.readFile(path.join(first.directory,first.manifest),'utf8');
  assert.equal(csv[0],'\ufeff');
  assert.ok(csv.includes('"’\t＝1+1\r\n原始 ""备注"""'));
  assert.ok(csv.includes('"素材清单 (2).csv","已导出"'));
  assert.ok(csv.includes('"不可用"') && csv.includes('原件暂不可用'));
  assert.ok(!csv.includes(root));
  const second = await runStructuredExport({ items:rows, options:{layout:'flat'}, destination:output,
    libraryRoots:[syncRoot,eagleRoot], copy,
  });
  assert.equal(second.directory,path.join(output,'见藏导出 (2)'));
  assert.equal(second.manifest,null);
  assert.deepEqual(await fs.readFile(path.join(second.directory,'素材清单.csv')),firstBytes);
  assert.deepEqual(await fs.readFile(firstFile),firstBytes);
  assert.deepEqual(await fs.readFile(secondFile),secondBytes);
});

test('native-approved destination cannot be an alias into a registered library, including during folder creation', async t => {
  const { root, output } = await workspace(t);
  const protectedRoot = path.join(root,'protected');
  const registeredAlias = path.join(root,'protected-alias');
  await fs.mkdir(protectedRoot);
  await fs.symlink(protectedRoot,registeredAlias,process.platform === 'win32' ? 'junction' : 'dir');
  const rows = [item(library('01','素材库'),'选片')];
  const copy = () => assert.fail('Protected output must be rejected before copying');
  await assert.rejects(runStructuredExport({ items:rows, destination:registeredAlias, libraryRoots:[protectedRoot], copy }),/素材库以外/);
  await assert.rejects(runStructuredExport({ items:rows, destination:protectedRoot, libraryRoots:[registeredAlias], copy }),/素材库以外/);
  assert.deepEqual(await fs.readdir(protectedRoot),[]);
  const empty = await runStructuredExport({ items:[{ name:'离线', available:false }], destination:output, options:{includeMetadata:true}, copy });
  assert.equal(empty.directory,null);
  assert.deepEqual(await fs.readdir(output),[]);
});

test('streamed manifest retains every chunk and reports individual copy failures without overwriting', async t => {
  const { output } = await workspace(t);
  const source = library('01','设计');
  const rows = Array.from({length:8},(_,i)=>item(source, `图 ${i}`, { note:`${i}` + '字'.repeat(12000) }));
  const result = await runStructuredExport({ items:rows, options:{layout:'flat',includeMetadata:true}, destination:output,
    copy(row,destination) {
      if (row.name === '图 4') throw new Error('原件校验失败。');
      return fs.writeFile(destination,row.name,{flag:'wx'});
    },
  });
  assert.equal(result.written,7);
  assert.deepEqual(result.failed,[{name:'图 4',message:'原件校验失败。'}]);
  const csv = await fs.readFile(path.join(result.directory,result.manifest),'utf8');
  assert.ok(csv.startsWith('\ufeff"素材名称"'));
  assert.ok(csv.includes('"图 0"') && csv.includes('"图 7"') && csv.includes('"原件校验失败。"'));
  assert.equal(csv.match(/字/g).length, 8 * 12000 + 1);
});

test('uses stable failure indices for matching names and reports each outcome across collections', async t => {
  const { output } = await workspace(t);
  const source = library('01', '设计', [folder('a', '图片'), folder('b', '待交付')]);
  const rows = [item(source, '素材', { collectionIds: ['a'], id: 'success-a' }),
    item(source, '素材', { collectionIds: ['b'], id: 'missing' }, false),
    item(source, '素材', { collectionIds: ['a'], id: 'bad-copy' }),
    item(source, '素材', { collectionIds: ['b'], id: 'success-b' })];
  const options = { layout: 'collections', includeMetadata: true };
  const snapshots = [];
  const first = await runStructuredExport({ items: rows, options, destination: output,
    onProgress: value => snapshots.push(value),
    copy(row, target) {
      const { id } = row.original.asset;
      if (id === 'bad-copy') throw new Error('原件无法读取。');
      return fs.writeFile(target, id, { flag: 'wx' });
    },
  });
  assert.deepEqual(first.failedIndices, [1, 2]);
  assert.deepEqual(snapshots, [
    { total: 4, processed: 1, written: 0, failed: 1, phase: 'copying' },
    { total: 4, processed: 2, written: 1, failed: 1, phase: 'copying' },
    { total: 4, processed: 3, written: 1, failed: 2, phase: 'copying' },
    { total: 4, processed: 4, written: 2, failed: 2, phase: 'copying' },
    { total: 4, processed: 4, written: 2, failed: 2, phase: 'manifest' },
  ]);
  const retry = await runStructuredExport({
    items: first.failedIndices.map(index => ({ ...rows[index], available: true })), options, destination: output,
    copy: (row, target) => fs.writeFile(target, row.original.asset.id, { flag: 'wx' }),
  });
  assert.deepEqual(retry.failedIndices, []);
  assert.equal(retry.written, 2);
  assert.equal(path.basename(retry.directory), '见藏导出 (2)');
  assert.equal(await fs.readFile(path.join(first.directory, '设计', '图片', '素材.png'), 'utf8'), 'success-a');
  assert.equal(await fs.readFile(path.join(retry.directory, '设计', '图片', '素材.png'), 'utf8'), 'bad-copy');
  assert.equal(await fs.readFile(path.join(retry.directory, '设计', '待交付', '素材.png'), 'utf8'), 'missing');
});
