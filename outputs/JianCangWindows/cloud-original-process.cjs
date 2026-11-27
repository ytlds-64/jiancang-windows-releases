'use strict';

const path = require('node:path');

function transferError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createCloudOriginalReader(fork, { idleMs = 120_000 } = {}) {
  return (spec, { signal, onProgress } = {}) => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = fork(path.join(__dirname, 'cloud-original-worker.cjs'), [], {
          serviceName: 'JianCang Original Download', stdio: 'ignore',
        });
      } catch {
        reject(transferError('PROVIDER', '无法启动原件取回进程，请重试。'));
        return;
      }
      let timer;
      let settled = false;
      let lastBytes = -1;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.kill();
        if (error) reject(error);
        else resolve(result);
      }
      function renewDeadline() {
        clearTimeout(timer);
        timer = setTimeout(() => finish(transferError('TIMEOUT', '取回超时，请确认 iCloud Drive 已登录和联网后重试。')), idleMs);
        timer.unref();
      }
      function onAbort() { finish(signal.reason); }
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', () => {
        if (settled) { child.kill(); return; }
        try { child.postMessage(spec); }
        catch { finish(transferError('PROVIDER', '无法请求原件取回，请重试。')); }
      });
      child.on('message', message => {
        if (settled) return;
        if (message?.type === 'progress' && Number.isSafeInteger(message.bytes) && message.bytes >= 0 &&
            message.bytes <= spec.byteCount && message.bytes !== lastBytes) {
          lastBytes = message.bytes;
          renewDeadline();
          onProgress?.(message.bytes);
        }
        if (message?.type === 'result') {
          if (message.ok === true && message.bytes === spec.byteCount) finish(null, { ok: true, bytes: message.bytes });
          else if (message.ok === false) finish(transferError(message.code, message.message));
          else finish(transferError('INCOMPLETE', '原件还未完整取回，请重试。'));
        }
      });
      child.once('error', () => finish(transferError('PROVIDER', '原件取回进程未能完成，请重试。')));
      child.once('exit', () => finish(transferError('PROVIDER', '原件取回进程已结束，请重试。')));
      renewDeadline();
      if (signal?.aborted) onAbort();
    });
  };
}

module.exports = { createCloudOriginalReader };
