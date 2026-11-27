'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } = require('node:crypto');
const app = path.resolve(__dirname, '../../outputs/JianCangWindows');
const { manifestName, updateFileName, releaseMessage, readManifest } = require(path.join(app, 'windows-update.cjs'));
const keyFolder = path.join(os.homedir(), 'Library', 'Application Support', '见藏构建');
const keyFile = path.join(keyFolder, 'windows-update-ed25519.pem');
const trustPath = path.join(app, 'update-trust.json');

async function signingKey() {
  await fs.mkdir(keyFolder, { recursive: true, mode: 0o700 });
  let raw;
  try { raw = await fs.readFile(keyFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const existing = await fs.stat(trustPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) throw new Error('已有更新公钥，但找不到原签名私钥。请恢复密钥后再签名。');
    const { privateKey } = generateKeyPairSync('ed25519');
    raw = privateKey.export({ type: 'pkcs8', format: 'pem' });
    await fs.writeFile(keyFile, raw, { flag: 'wx', mode: 0o600 });
  }
  return createPrivateKey(raw);
}

async function run(archive, outputDirectory) {
  const privateKey = await signingKey();
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('更新签名需要 Ed25519 密钥。');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const saved = await fs.readFile(trustPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (saved === null) await fs.writeFile(trustPath, JSON.stringify({ publicKey }, null, 2) + '\n', { flag: 'wx' });
  else if (JSON.parse(saved).publicKey !== publicKey) throw new Error('当前密钥与已发布的更新公钥不匹配。');
  if (!archive) return;
  const { version } = require(path.join(app, 'package.json'));
  const file = updateFileName(version);
  if (path.basename(archive) !== file || !outputDirectory) throw new Error('请选择当前版本的 Windows x64 更新包。');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(archive)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  const release = { format: 1, version, file, bytes, sha256: hash.digest('hex') };
  release.signature = sign(null, releaseMessage(release), privateKey).toString('base64');
  const json = JSON.stringify(release, null, 2) + '\n';
  readManifest(json, publicKey);
  await fs.writeFile(path.join(outputDirectory, manifestName), json, { flag: 'wx' });
}

run(...process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
