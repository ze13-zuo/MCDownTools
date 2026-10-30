import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchWithRetry, tryFetchText } from '../utils/http.js';

const DOWNLOAD_TIMEOUT = 30 * 60 * 1000;
const IDLE_TIMEOUT = 60 * 1000;
const PROGRESS_INTERVAL = 200;
const DOWNLOAD_ATTEMPTS = 3;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentOf(received, total) {
  return total ? Math.min(100, Math.round((received / total) * 100)) : 0;
}

/**
 * 下载文件到本地，支持进度回调与 sha1 计算
 * 连接中断或长时间无数据时会自动重试整个下载
 * @param {string} url
 * @param {string} destPath
 * @param {{ onProgress?: (progress: { fileName: string, received: number, total: number, percent: number }) => void, attempts?: number, idleTimeout?: number, timeout?: number }} [options]
 * @returns {Promise<{ path: string, size: number, sha1: string }>}
 */
export async function downloadFile(url, destPath, options = {}) {
  await mkdir(dirname(destPath), { recursive: true });

  // 大量小文件场景可传 attempts: 1，失败后立即换备用源，避免长时间卡在单个源
  const attempts = options.attempts ?? DOWNLOAD_ATTEMPTS;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadOnce(
        url,
        destPath,
        options.onProgress,
        options.idleTimeout ?? IDLE_TIMEOUT,
        options.timeout ?? DOWNLOAD_TIMEOUT,
      );
    } catch (err) {
      lastError = err;
      await rm(`${destPath}.part`, { force: true });
      if (attempt < attempts) await delay(attempt * 1000);
    }
  }

  throw lastError;
}

async function downloadOnce(url, destPath, onProgress, idleTimeout = IDLE_TIMEOUT, timeout = DOWNLOAD_TIMEOUT) {
  const response = await fetchWithRetry(url, { timeout, attempts: 1 });

  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  if (!response.body) throw new Error(`响应体为空: ${url}`);

  const total = Number(response.headers.get('content-length') ?? 0);
  const tempPath = `${destPath}.part`;
  const hash = createHash('sha1');
  const fileName = basename(destPath);
  let received = 0;
  let lastEmit = 0;

  const stream = Readable.fromWeb(response.body);
  let idleTimer = null;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stream.destroy(new Error('下载超时：长时间未收到数据'));
    }, idleTimeout);
  };
  resetIdleTimer();

  stream.on('data', (chunk) => {
    received += chunk.length;
    hash.update(chunk);
    resetIdleTimer();

    const now = Date.now();
    if (onProgress && (now - lastEmit > PROGRESS_INTERVAL || (total > 0 && received === total))) {
      lastEmit = now;
      onProgress({ fileName, received, total, percent: percentOf(received, total) });
    }
  });

  try {
    await pipeline(stream, createWriteStream(tempPath));
    await rename(tempPath, destPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }

  return { path: destPath, size: received, sha1: hash.digest('hex') };
}

/**
 * 获取远程文件的 sha1（Maven 仓库在文件旁边提供 .sha1）
 * @param {string} url
 * @returns {Promise<string | null>}
 */
export async function fetchExpectedSha1(url) {
  const text = await tryFetchText(`${url}.sha1`, { timeout: 15_000 });
  const hash = text?.trim().split(/\s+/)[0]?.toLowerCase();
  return hash && /^[a-f0-9]{40}$/.test(hash) ? hash : null;
}
