'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { Readable } = require('node:stream');

const redirects = new Set([301, 302, 303, 307, 308]);
const maximumHeader = 64 * 1024;
const readIdleTime = 45_000;
const redirectError = 'GitHub 更新文件的跳转地址有误，请检查发布附件。';

// Windows PowerShell uses the current user's Internet Options via .NET Framework.
// Read the response's raw Location, leaving redirect authorization to the updater.
const worker = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$output = [Console]::OpenStandardOutput()
$sent = $false
$resolvingProxy = $false
$usingProxy = $false
function Write-Header($header) {
  $json = ConvertTo-Json -InputObject $header -Compress -Depth 4
  $encoded = [Text.Encoding]::UTF8.GetBytes($json)
  if ($encoded.Length -gt 65536) { throw 'Response header too large.' }
  $output.Write($encoded, 0, $encoded.Length)
  $output.WriteByte(10)
  $output.Flush()
}
try {
  $inputStream = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  try { $inputData = ConvertFrom-Json -InputObject ($inputStream.ReadToEnd()) } finally { $inputStream.Dispose() }
  $uri = [Uri]::new([string]$inputData.url, [UriKind]::Absolute)
  if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment) { throw 'Invalid update URL.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::SystemDefault
  $request = [Net.WebRequest]::Create($uri)
  $request.Method = 'GET'
  $request.AllowAutoRedirect = $false
  $request.UserAgent = 'JianCang-Windows-Update/1.0'
  $request.UseDefaultCredentials = $false
  $request.PreAuthenticate = $false
  $request.AutomaticDecompression = [Net.DecompressionMethods]::None
  $request.MaximumResponseHeadersLength = 64
  $request.Timeout = 20000
  $request.ReadWriteTimeout = 35000
  $request.CachePolicy = [Net.Cache.RequestCachePolicy]::new([Net.Cache.RequestCacheLevel]::NoCacheNoStore)
  $request.Headers['Cache-Control'] = 'no-cache'
  if ($null -ne $inputData.offset) {
    $request.AddRange([long]$inputData.offset)
    $request.Headers['Accept-Encoding'] = 'identity'
  }

  $resolvingProxy = $true
  $proxy = [Net.WebRequest]::GetSystemWebProxy()
  $proxy.Credentials = $null
  $usingProxy = -not $proxy.IsBypassed($uri)
  $request.Proxy = $proxy
  $resolvingProxy = $false
  try { $response = $request.GetResponse() } catch {
    $failure = $_.Exception
    while ($failure -and -not ($failure -is [Net.WebException])) { $failure = $failure.InnerException }
    if (-not $failure -or -not ($failure.Response -is [Net.HttpWebResponse])) { throw }
    $response = $failure.Response
  }
  try {
    $headers = @{}
    foreach ($name in @('location', 'content-range', 'content-encoding', 'x-ms-error-code')) {
      $values = @($response.Headers.GetValues($name))
      if ($values.Count -eq 1 -and $null -ne $values[0]) { $headers[$name] = $values[0] }
    }
    $status = [int]$response.StatusCode
    Write-Header @{ status = $status; headers = $headers }
    $sent = $true
    if ($status -eq 200 -or $status -eq 206) {
      $stream = $response.GetResponseStream()
      if ($stream) {
        try { $stream.CopyTo($output, 65536) } finally { $stream.Dispose() }
      }
      $output.Flush()
    }
  } finally { $response.Dispose() }
} catch {
  if (-not $sent) {
    $reason = if ($resolvingProxy) { 'proxy' } else { 'network' }
    $failure = $_.Exception
    while ($failure) {
      if ($failure -is [Net.WebException]) {
        switch ($failure.Status.ToString()) {
          'ProxyNameResolutionFailure' { $reason = 'proxy' }
          'ConnectFailure' { if ($usingProxy) { $reason = 'proxy' } }
          'TrustFailure' { $reason = 'certificate' }
          'SecureChannelFailure' { $reason = 'certificate' }
          'Timeout' { $reason = 'timeout' }
        }
        break
      }
      $failure = $failure.InnerException
    }
    Write-Header @{ error = $reason }
  }
  exit 1
}
`;

function startWindowsWorker() {
  const root = process.env.SystemRoot;
  if (process.platform !== 'win32' || typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root)) {
    throw new Error('Windows 更新网络组件不可用，可使用签名更新文件夹。');
  }
  const exe = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', worker],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

function transportError(reason) {
  if (reason === 'proxy') return new Error('net::ERR_PROXY_CONNECTION_FAILED');
  if (reason === 'certificate') return new Error('更新服务器的 HTTPS 连接无法验证，请检查系统日期和代理设置。');
  if (reason === 'timeout') return new DOMException('Update request timed out', 'TimeoutError');
  return new TypeError('Windows update transport failed');
}

async function readHeader(iterator) {
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) throw transportError();
    const lineEnd = value.indexOf(10);
    const piece = lineEnd === -1 ? value : value.subarray(0, lineEnd);
    length += piece.length;
    if (length > maximumHeader) throw transportError();
    chunks.push(piece);
    if (lineEnd === -1) continue;
    let metadata;
    try { metadata = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { throw transportError(); }
    if (metadata?.error) throw transportError(metadata.error);
    if (!Number.isInteger(metadata?.status) || metadata.status < 100 || metadata.status > 599 ||
        !metadata.headers || typeof metadata.headers !== 'object' || Array.isArray(metadata.headers)) throw transportError();
    const headers = new Map(Object.entries(metadata.headers).filter(([, value]) => typeof value === 'string'));
    return { status: metadata.status, headers, first: value.subarray(lineEnd + 1) };
  }
}

async function requestOnce(rawUrl, offset, signal, start) {
  signal?.throwIfAborted();
  const child = start();
  let idle;
  let exited;
  let stopped;
  const release = () => {
    clearTimeout(idle);
    signal?.removeEventListener('abort', abort);
  };
  function stop(error) {
    if (stopped) return;
    stopped = true;
    release();
    if (!exited) child.kill();
    child.stdout.destroy(error);
    child.stdin.destroy();
  }
  function abort() { stop(signal.reason); }
  function resetIdle() {
    clearTimeout(idle);
    if (!exited) {
      idle = setTimeout(() => stop(transportError('timeout')), readIdleTime);
      idle.unref();
    }
  }
  const completion = new Promise(resolve => {
    child.once('close', code => { exited = true; release(); resolve(code); });
    child.once('error', () => stop(new Error('Windows 更新网络组件不可用，可使用签名更新文件夹。')));
  });
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  const input = child.stdout[Symbol.asyncIterator]();
  signal?.addEventListener('abort', abort, { once: true });
  resetIdle();
  try {
    signal?.throwIfAborted();
    // The URL and range are data sent over stdin, never interpolated into the shell script.
    child.stdin.end(JSON.stringify({ url: rawUrl, offset }));
    const { status, headers, first } = await readHeader(input);
    if (status === 407) throw new Error('net::ERR_PROXY_AUTH_REQUESTED');
    if (status !== 200 && status !== 206) {
      stop();
      return { status, headers };
    }
    async function* streamBody() {
      try {
        if (first.length) yield first;
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await input.next();
          if (done) break;
          resetIdle();
          yield value;
        }
        signal?.throwIfAborted();
        if (await completion !== 0) throw transportError();
      } finally { stop(); }
    }
    resetIdle();
    const stream = Readable.from(streamBody(), { objectMode: false, highWaterMark: 64 * 1024 });
    stream.once('close', stop);
    return { status, headers, body: Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: bytes => bytes.byteLength },
    }) };
  } catch (error) {
    stop();
    throw error;
  }
}

function requestedOffset(headers) {
  const range = /^bytes=(\d{1,10})-$/.exec(headers?.Range ?? '');
  return range ? Number(range[1]) : null;
}

function createWindowsUpdateRequest({ start = startWindowsWorker } = {}) {
  return async (url, { signal, redirect = 'error', headers, attachment } = {}) => {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password || address.hash) throw transportError();
    const response = await requestOnce(address.href, attachment ? null : requestedOffset(headers), signal, start);
    if (!redirects.has(response.status)) return response;
    if (redirect !== 'manual') throw new Error(redirectError);
    if (!attachment) return response;
    const location = response.headers.get('location');
    let target;
    try { if (location) target = new URL(location, address); } catch {}
    if (!target || !attachment.allowsRedirect(response.status, 'GET', target.href, location)) throw new Error(redirectError);
    // Send the original signed query rather than reconstructing it from URLSearchParams.
    const rawLocation = /^https:\/\//i.test(location) ? location : target.href;
    const download = await requestOnce(rawLocation, requestedOffset(attachment.headers), signal, start);
    if (redirects.has(download.status)) throw new Error(redirectError);
    return { ...download, followedAttachment: true };
  };
}

module.exports = { createWindowsUpdateRequest };
