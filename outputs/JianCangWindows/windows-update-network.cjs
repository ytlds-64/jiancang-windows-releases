'use strict';

const { Readable } = require('node:stream');

function responseHeaders(headers) {
  const result = new Map();
  for (const [name, raw] of Object.entries(headers)) {
    const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
    if (typeof value === 'string') result.set(name.toLowerCase(), value);
  }
  return result;
}

function createUpdateRequest(session, netRequest) {
  return (url, { signal, redirect = 'error', cache = 'no-store', headers = {}, attachment }) => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = netRequest({ url: url.href, session, redirect, cache, credentials: 'omit' });
      for (const [name, value] of Object.entries({ ...headers, ...attachment?.headers })) request.setHeader(name, value);
      let incoming;
      let followedAttachment = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      function abort() {
        incoming?.destroy(signal.reason);
        request.abort();
        reject(signal.reason);
      }

      request.on('error', error => {
        cleanup();
        reject(error);
      });
      request.on('redirect', (status, method, target, rawHeaders) => {
        const receivedHeaders = responseHeaders(rawHeaders);
        const location = receivedHeaders.get('location');
        if (!followedAttachment && redirect === 'manual' && attachment?.allowsRedirect(status, method, target, location)) {
          followedAttachment = true;
          // Continue Chromium's existing request with the original signed Location.
          request.followRedirect();
          return;
        }
        cleanup();
        request.abort();
        if (attachment) reject(new Error('GitHub 更新文件的跳转地址有误，请检查发布附件。'));
        else resolve({ status, headers: receivedHeaders });
      });
      request.once('response', response => {
        incoming = response;
        response.once('close', () => {
          cleanup();
          if (!response.readableEnded) request.abort();
        });
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: responseHeaders(response.headers),
          followedAttachment,
          body: Readable.toWeb(response, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          }),
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      request.end();
    });
  };
}

module.exports = { createUpdateRequest };
