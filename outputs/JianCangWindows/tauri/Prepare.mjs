import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMedia } from './Prepare-Media.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const app = dirname(root);
const input = process.argv[2];
const nodeVersion = '24.22.3';
const nodeDirectory = `node-v${nodeVersion}-win-x64`;
const nodeDigest = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f';
const version = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;

if (!input) throw new Error('Usage: node Prepare.mjs <official Node Windows x64 ZIP | --frontend-only>');
const runtime = input === '--frontend-only' ? null : resolve(input);
if (runtime && createHash('sha256').update(await readFile(runtime)).digest('hex') !== nodeDigest) {
  throw new Error(`Node.js archive SHA-256 does not match ${nodeDirectory}.zip.`);
}

function replaceRequired(text, before, after) {
  if (!text.includes(before)) throw new Error(`Renderer contract has changed: ${before}`);
  return text.replace(before, after);
}

const stage = await mkdtemp(join(root, '.prepare-'));
const generated = join(root, 'generated');
const frontend = join(stage, 'frontend');
const backend = join(stage, 'backend');
try {
  await cp(join(app, 'ui'), frontend, { recursive: true });
  await cp(join(app, 'vendor/pdfjs'), join(frontend, 'pdfjs'), { recursive: true });
  for (const file of ['tauri-platform.js', 'tauri-platform.css', 'reference-platform.js', 'window-chrome.js']) {
    await copyFile(join(root, 'frontend', file), join(frontend, file));
  }
  let preload = await readFile(join(app, 'preload.cjs'), 'utf8');
  preload = replaceRequired(preload, "const { contextBridge, ipcRenderer, webUtils } = require('electron');",
    'const { contextBridge, ipcRenderer, webUtils } = window.jiancangTauriPlatform;');
  preload = replaceRequired(preload, "windowsCaption: process.platform === 'win32',", 'windowsCaption: true,');
  await writeFile(join(frontend, 'tauri-preload.js'), preload);

  const index = join(frontend, 'index.html');
  let html = await readFile(index, 'utf8');
  html = replaceRequired(html,
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' jiancang:; media-src jiancang:; connect-src \'self\'; worker-src \'self\'; base-uri \'none\'; form-action \'none\'">\n',
    '');
  html = replaceRequired(html, '    <title>见藏</title>',
    '    <title>见藏</title>\n    <link rel="stylesheet" href="./tauri-platform.css">\n    <script src="./offline-web-extract.js" defer></script>\n    <script src="./tauri-platform.js" defer></script>\n    <script src="./tauri-preload.js" defer></script>\n    <script src="./window-chrome.js" defer></script>');
  html = replaceRequired(html, 'id="help-app-version" role="status">正在读取版本…',
    `id="help-app-version" role="status">当前版本 ${version}`);
  await writeFile(index, html);

  const reference = join(frontend, 'reference.html');
  await writeFile(reference, replaceRequired(await readFile(reference, 'utf8'),
    '  <script src="reference.js" defer></script>',
    '  <script src="reference-platform.js" defer></script>\n  <script src="reference.js" defer></script>'));

  const renderer = join(frontend, 'renderer.js');
  const renderSource = await readFile(renderer, 'utf8');
  const migrated = replaceRequired(renderSource,
    "  const namespace = ['video', 'board-image', 'palette-image', 'edit-image', 'pdf-original', 'text-preview'].includes(host) ? `app/${host}` : host;\n  const location = `jiancang://${namespace}/${asset.sourceLibraryId}/${asset.sourceAssetId}`;",
    '  const location = window.jiancangTauriPlatform.mediaURL(host, asset.sourceLibraryId, asset.sourceAssetId);');
  await writeFile(renderer, migrated);

  const pdf = join(frontend, 'pdf-preview.js');
  await writeFile(pdf, replaceRequired(await readFile(pdf, 'utf8'),
    "const resources = 'jiancang://app/pdfjs/';", "const resources = new URL('./pdfjs/', location.href).href;"));

  const videoTrim = join(frontend, 'video-trim.js');
  await writeFile(videoTrim, replaceRequired(await readFile(videoTrim, 'utf8'),
    "    const url = typeof value === 'string' && URL.parse(value);\n    return url?.protocol === 'jiancang:' && !url.username && !url.password ? url.href : '';",
    "    return window.jiancangTauriPlatform.playbackURL(value);"));

  const board = join(frontend, 'project-boards.js');
  await writeFile(board, replaceRequired(await readFile(board, 'utf8'),
    "      image.onerror = () => { clearTimeout(timer); fail(); };\n      image.src = src;",
    "      image.onerror = () => { clearTimeout(timer); fail(); };\n      image.crossOrigin = 'anonymous';\n      image.src = src;"));

  await mkdir(join(backend, 'tauri/backend'), { recursive: true });
  for (const entry of await readdir(app, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z-]+\.cjs$/.test(entry.name)
      && !['main.cjs', 'preload.cjs', 'reference-preload.cjs'].includes(entry.name)) {
      await copyFile(join(app, entry.name), join(backend, entry.name));
    }
  }
  for (const entry of await readdir(join(root, 'backend'), { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z-]+\.cjs$/.test(entry.name) && !entry.name.endsWith('-test.cjs')) {
      await copyFile(join(root, 'backend', entry.name), join(backend, 'tauri/backend', entry.name));
    }
  }
  await readFile(join(backend, 'tauri/backend/server.cjs'));
  await copyFile(join(app, 'update-trust.json'), join(backend, 'update-trust.json'));
  await cp(join(app, 'browser-extension'), join(backend, 'browser-extension'), { recursive: true,
    filter: file => !['.DS_Store', '.git'].includes(file.split(/[\\/]/).at(-1)) });
  await prepareMedia({ app, backend, windows: !!runtime });
  if (runtime) {
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    execFileSync(tar, ['-xf', runtime, '-C', stage, `${nodeDirectory}/node.exe`, `${nodeDirectory}/LICENSE`]);
    await rename(join(stage, nodeDirectory, 'node.exe'), join(backend, 'node.exe'));
    await rename(join(stage, nodeDirectory, 'LICENSE'), join(backend, 'LICENSE.node.txt'));
    await rm(join(stage, nodeDirectory), { recursive: true, force: true });
  }
  await rm(generated, { recursive: true, force: true });
  await rename(stage, generated);
  console.log('Prepared the production renderer and the Tauri library service.');
} finally {
  await rm(stage, { recursive: true, force: true });
}
