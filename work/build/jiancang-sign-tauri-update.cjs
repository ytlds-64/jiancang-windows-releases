'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, randomUUID, sign } = require('node:crypto');
const app = path.resolve(__dirname, '../../outputs/JianCangWindows');
const { candidateReleaseFormat, stableReleaseFormat, updateFileName, releaseMessage, readManifest } =
  require(path.join(app, 'windows-update.cjs'));

async function signCandidate(installer, keyFile, { version, publicKey, production = false }) {
  const releaseFormat = production ? stableReleaseFormat : candidateReleaseFormat;
  const file = updateFileName(version, releaseFormat);
  if (path.basename(installer) !== file) throw new Error(`请选择 ${file}。`);
  const key = createPrivateKey(await fs.readFile(keyFile));
  const trust = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  const spki = { type: 'spki', format: 'der' };
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export(spki).equals(trust.export(spki))) {
    throw new Error('所选签名密钥与见藏内置的更新公钥不匹配。');
  }

  const handle = await fs.open(installer, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size <= 0 || initial.size > 1024 ** 3) throw new Error('安装包大小无效。');
    for await (const chunk of handle.createReadStream({ autoClose: false, end: initial.size - 1 })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    const final = await handle.stat();
    const source = await fs.stat(installer);
    if (bytes !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs ||
        final.ctimeMs !== initial.ctimeMs || source.dev !== initial.dev || source.ino !== initial.ino ||
        source.size !== initial.size || source.mtimeMs !== initial.mtimeMs || source.ctimeMs !== initial.ctimeMs) {
      throw new Error('安装包在签名时发生变化，请重新运行。');
    }
  } finally { await handle.close(); }

  const release = { format: 1, version, file, bytes, sha256: hash.digest('hex') };
  release.signature = sign(null, releaseMessage(release, releaseFormat), key).toString('base64');
  const json = JSON.stringify(release, null, 2) + '\n';
  readManifest(json, publicKey, releaseFormat);
  const output = path.join(path.dirname(installer), releaseFormat.manifestName);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, json, { flag: 'wx' });
    await fs.link(temporary, output);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return output;
}

async function main(args) {
  const production = args[0] === '--production';
  if (production) args = args.slice(1);
  if (args.length !== 2) {
    throw new Error('用法  node work/build/jiancang-sign-tauri-update.cjs [--production] <安装包路径> <Ed25519 签名密钥文件>');
  }
  const [installer, keyFile] = args.map(filename => path.resolve(filename));
  const [{ version }, { publicKey }] = await Promise.all([
    fs.readFile(path.join(app, 'tauri/src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(app, 'update-trust.json'), 'utf8').then(JSON.parse),
  ]);
  console.log(await signCandidate(installer, keyFile, { version, publicKey, production }));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { signCandidate };
