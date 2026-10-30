/** 基于 Node 内置 fetch 的简单 HTTP 工具 */

const DEFAULT_TIMEOUT = 60_000;
const RETRY_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch（仅对连接阶段的错误重试，HTTP 错误码不重试）
 * @param {string} url
 * @param {{ timeout?: number, attempts?: number }} [options]
 */
export async function fetchWithRetry(url, { timeout = DEFAULT_TIMEOUT, attempts = RETRY_ATTEMPTS } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(attempt * 1000);
    }
  }

  const cause = lastError?.cause?.code ?? lastError?.cause?.message ?? lastError?.message;
  throw new Error(`网络请求失败（${cause}）: ${url}`);
}

/**
 * 获取文本内容
 * @param {string} url
 * @param {{ timeout?: number, attempts?: number }} [options]
 */
export async function fetchText(url, options) {
  const response = await fetchWithRetry(url, options);
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}: ${url}`);
  }
  return response.text();
}

/**
 * 获取并解析 JSON
 * @param {string} url
 */
export async function fetchJson(url, options) {
  return JSON.parse(await fetchText(url, options));
}

/**
 * 获取文本，失败时返回 null（用于可选资源）
 * @param {string} url
 */
export async function tryFetchText(url, options) {
  try {
    return await fetchText(url, options);
  } catch {
    return null;
  }
}
