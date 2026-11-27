'use strict';

const path = require('node:path');
const { lookup } = require('node:dns');
const { BlockList, isIP } = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { exportFilename } = require('./original-file.cjs');
const { webURL } = require('./local-workflow.cjs');

const maximumImageBytes = 32 * 1024 ** 2;
const blocked = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, bits);
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/x-ms-bmp', 'image/avif']);
const redirects = new Set([301, 302, 303, 307, 308]);

function imageExtension(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 13 || bytes.byteLength > maximumImageBytes) return null;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'gif';
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(data.readUInt32BE(0), data.length, 256);
    for (let offset = 8; offset + 4 <= end; offset += offset === 8 ? 8 : 4) {
      if (['avif', 'avis'].includes(data.toString('ascii', offset, offset + 4))) return 'avif';
    }
  }
  return null;
}

function imageFilename(name, extension) {
  const stem = typeof name === 'string' ? path.win32.parse(name.trim()).name : '';
  return exportFilename(stem || '拖入的图片', extension);
}

function inlineImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximumImageBytes / 3) * 4 + 80) return null;
  const match = /^data:([^;,]+);base64,([a-z\d+/]+={0,2})$/i.exec(value);
  if (!match || !rasterTypes.has(match[1].toLowerCase()) || match[2].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[2], 'base64');
  return imageExtension(bytes) ? bytes : null;
}

function publicAddress(address) {
  return isIP(address) === 4 && !blocked.check(address);
}

function publicImageURL(value) {
  const normal = webURL(value);
  if (!normal) return null;
  const url = new URL(normal);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.port || isIP(hostname) === 6 || hostname.includes(':') || !hostname.includes('.') ||
      /\.(?:localhost|local|internal|lan|home|arpa)$/i.test(hostname) ||
      (isIP(hostname) && !publicAddress(hostname))) return null;
  url.hash = '';
  return url;
}

function imageURLCandidates(values) {
  const candidates = Array.isArray(values) ? values.slice(0, 3) : [values];
  return [...new Set(candidates.map(value => publicImageURL(value)?.href).filter(Boolean))];
}

function lookupImageHost(hostname, _options, callback) {
  lookup(hostname, { family: 4, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const match = addresses.find(({ address }) => publicAddress(address));
    if (!match) return callback(new Error('图片地址不在公共网络。'));
    callback(null, match.address, 4);
  });
}

function openImage(url, signal) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      signal, lookup: lookupImageHost, family: 4, agent: false,
      headers: { Accept: [...rasterTypes].join(', '), 'Accept-Encoding': 'identity' },
    }, resolve);
    request.on('error', reject);
  });
}

async function readDroppedImage(sourceURL, open, signal) {
  let url = new URL(sourceURL);
  for (let count = 0; count <= 3; count++) {
    const response = await open(url, signal);
    try {
      if (redirects.has(response.statusCode) && count < 3 && response.headers.location) {
        const next = publicImageURL(new URL(response.headers.location, url).href);
        const rootHost = name => name.replace(/^www\./i, '');
        if (next && rootHost(next.hostname) === rootHost(url.hostname) &&
            (next.protocol === url.protocol || next.protocol === 'https:')) {
          url = next;
          continue;
        }
      }
      const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (response.statusCode !== 200 || (!rasterTypes.has(type) && type !== 'application/octet-stream')) {
        throw new Error('网页没有返回可导入的图片，请将图片另存为文件后再拖入。');
      }
      if (Number(response.headers['content-length']) > maximumImageBytes) throw new Error('网页图片超过 32 MB。');
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maximumImageBytes) throw new Error('网页图片超过 32 MB。');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      const extension = imageExtension(bytes);
      if (!extension) throw new Error('未能识别网页图片格式。');
      const leaf = url.pathname.split('/').at(-1);
      let name = leaf;
      try { name = decodeURIComponent(leaf); } catch {}
      return { kind: 'buffer', bytes, name: imageFilename(name, extension), sourceURL,
        ...(url.href !== sourceURL && { resolvedImageURL: url.href }) };
    } finally { response.destroy(); }
  }
  throw new Error('无法读取网页图片。');
}

async function downloadDroppedImage(value, { open = openImage, signal } = {}) {
  const candidates = imageURLCandidates(value);
  signal ??= AbortSignal.timeout(candidates.length > 1 ? 25_000 : 15_000);
  let failure;
  for (const [index, candidate] of candidates.entries()) {
    signal.throwIfAborted();
    const attempt = candidates.length > 1 ? AbortSignal.any([signal, AbortSignal.timeout(index ? 5_000 : 15_000)]) : signal;
    try { return await readDroppedImage(candidate, open, attempt); }
    catch (error) { failure = error; }
  }
  throw failure ?? new Error('无法读取这个图片地址，请另存为文件后再拖入。');
}

module.exports = { maximumImageBytes, imageExtension, imageFilename, inlineImage, publicAddress, publicImageURL,
  lookupImageHost, imageURLCandidates, downloadDroppedImage };
