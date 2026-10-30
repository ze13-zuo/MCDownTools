import { release as osRelease } from 'node:os';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fetchVersionDetail } from './version.js';
import { downloadFile } from './downloader.js';
import { rewriteUrl } from './mirror.js';

/** 当前系统在版本 json 中对应的名称 */
const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const OS_ARCH = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86';
const BATCH_CONCURRENCY = 8;
const PROGRESS_INTERVAL = 200;
/** 并发下载线程数上限与默认值（同时下载的文件数） */
export const MAX_THREADS = 128;
export const DEFAULT_THREADS = 32;

/** 规范化线程数：限制在 1–128 */
export function clampThreads(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_THREADS;
  return Math.min(MAX_THREADS, n);
}

// 资源文件体积小、数量多：单源只尝试 1 次，失败立即换源；连续失败若干次后直接优先官方源
const ASSET_ATTEMPTS = 1;
const ASSET_IDLE_TIMEOUT = 15 * 1000;
const ASSET_TIMEOUT = 120 * 1000;
// 库文件体积较大，单源重试 2 次并缩短无数据等待时间
const LIBRARY_ATTEMPTS = 2;
const LIBRARY_IDLE_TIMEOUT = 20 * 1000;
const PRIMARY_FAILURE_LIMIT = 5;

/** 判断规则是否匹配当前系统（name / arch / version） */
function ruleMatches(rule) {
  const os = rule.os;
  if (!os) return true;
  if (os.name && os.name !== OS_NAME) return false;
  if (os.arch && os.arch !== OS_ARCH) return false;
  if (os.version) {
    try {
      if (!new RegExp(os.version).test(osRelease())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 按 rules 判断库文件是否需要在当前平台下载 */
function isLibraryAllowed(library) {
  if (!library.rules) return true;

  let allowed = false;
  for (const rule of library.rules) {
    if (ruleMatches(rule)) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 老版本库文件通过 natives 字段指定平台分类器 */
function nativeClassifier(library) {
  const key = library.natives?.[OS_NAME];
  if (!key) return null;
  return key.replace('${arch}', process.arch === 'x64' ? '64' : '32');
}

/** 收集需要在当前平台下载的库文件（去重） */
function collectLibraries(detail) {
  const items = new Map();

  for (const library of detail.libraries ?? []) {
    if (!isLibraryAllowed(library)) continue;

    const artifact = library.downloads?.artifact;
    if (artifact?.path) {
      items.set(artifact.path, { path: artifact.path, url: artifact.url, size: artifact.size });
    }

    const classifier = nativeClassifier(library);
    const native = classifier ? library.downloads?.classifiers?.[classifier] : null;
    if (native?.path) {
      items.set(native.path, { path: native.path, url: native.url, size: native.size });
    }
  }

  return [...items.values()];
}

/** 带并发限制的批量下载，支持跳过已存在的文件与整体进度 */
async function downloadBatch(
  items,
  { label, log, onProgress, concurrency = BATCH_CONCURRENCY, attempts, idleTimeout, timeout },
) {
  const total = items.length;
  if (!total) return;

  const queue = [...items];
  const errors = [];
  const source = { primaryFailures: 0, preferFallback: false };
  let done = 0;
  let lastEmit = 0;

  const emit = () => {
    const now = Date.now();
    if (onProgress && (now - lastEmit > PROGRESS_INTERVAL || done === total)) {
      lastEmit = now;
      onProgress({ fileName: label, received: done, total, percent: Math.round((done / total) * 100) });
    }
  };

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();

      const info = await stat(item.dest).catch(() => null);
      if (info && info.size > 0 && (!item.size || info.size === item.size)) {
        done += 1;
        emit();
        continue;
      }

      // 主源连续失败后改走备用源优先，避免每个文件都先等主源超时
      const candidates = item.fallbackUrl && item.fallbackUrl !== item.url
        ? (source.preferFallback ? [item.fallbackUrl, item.url] : [item.url, item.fallbackUrl])
        : [item.url];

      let lastError = null;
      for (const url of candidates) {
        try {
          await downloadFile(url, item.dest, { attempts, idleTimeout, timeout });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (url === item.url) {
            source.primaryFailures += 1;
            if (source.primaryFailures >= PRIMARY_FAILURE_LIMIT) source.preferFallback = true;
          }
        }
      }

      if (lastError) errors.push(`${item.url} -> ${lastError.message}`);

      done += 1;
      emit();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  if (errors.length) {
    throw new Error(`${label}下载失败 ${errors.length}/${total} 个，首个错误: ${errors[0]}`);
  }

  log(`${label}：${total} 个文件全部完成`);
}

/** 下载资源索引与全部资源对象 */
async function downloadAssets(detail, targetDir, mirror, hooks) {
  const index = detail.assetIndex;
  if (!index) return;

  const indexPath = join(targetDir, 'assets', 'indexes', `${index.id}.json`);
  try {
    await downloadFile(rewriteUrl(index.url, mirror), indexPath, {
      attempts: ASSET_ATTEMPTS,
      idleTimeout: ASSET_IDLE_TIMEOUT,
      timeout: ASSET_TIMEOUT,
    });
  } catch {
    // 镜像偶发失败时回退到官方资源地址
    await downloadFile(rewriteUrl(index.url, 'official'), indexPath);
  }

  const data = JSON.parse(await readFile(indexPath, 'utf8'));
  const baseUrl = rewriteUrl('https://resources.download.minecraft.net', mirror);
  const fallbackBase = rewriteUrl('https://resources.download.minecraft.net', 'official');
  const seen = new Set();

  const items = [];
  for (const object of Object.values(data.objects ?? {})) {
    const hash = object?.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    items.push({
      url: `${baseUrl}/${hash.slice(0, 2)}/${hash}`,
      fallbackUrl: `${fallbackBase}/${hash.slice(0, 2)}/${hash}`,
      dest: join(targetDir, 'assets', 'objects', hash.slice(0, 2), hash),
      size: object.size,
    });
  }

  hooks.log(`资源文件共 ${items.length} 个（约 ${(index.totalSize / 1024 / 1024).toFixed(1)} MB）`);
  await downloadBatch(items, {
    label: '资源文件',
    log: hooks.log,
    onProgress: hooks.onProgress,
    concurrency: hooks.threads ?? BATCH_CONCURRENCY,
    attempts: ASSET_ATTEMPTS,
    idleTimeout: ASSET_IDLE_TIMEOUT,
    timeout: ASSET_TIMEOUT,
  });
}

/**
 * 下载原版游戏文件（版本 json、client.jar、libraries、assets）
 * @param {string} gameVersion
 * @param {{
 *   gameDir: string,
 *   mirror?: string,
 *   downloadAssets?: boolean,
 *   threads?: number,
 *   log?: (message: string) => void,
 *   onProgress?: Function
 * }} options
 */
export async function downloadVanillaGame(gameVersion, options = {}) {
  const {
    gameDir,
    mirror = 'auto',
    downloadAssets: withAssets = true,
    threads = DEFAULT_THREADS,
    log = () => {},
    onProgress,
  } = options;

  const detail = await fetchVersionDetail(gameVersion, mirror);
  const targetDir = resolve(gameDir);
  const versionDir = join(targetDir, 'versions', detail.id);

  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, `${detail.id}.json`), JSON.stringify(detail, null, 2), 'utf8');
  log(`已写入版本清单 versions/${detail.id}/${detail.id}.json`);

  const client = detail.downloads?.client;
  if (client) {
    const jarPath = join(versionDir, `${detail.id}.jar`);
    const existing = await stat(jarPath).catch(() => null);
    if (existing && existing.size > 0 && (!client.size || existing.size === client.size)) {
      log(`client.jar 已存在（${(existing.size / 1024 / 1024).toFixed(2)} MB），跳过下载`);
    } else {
      log('下载原版 client.jar');
      try {
        await downloadFile(rewriteUrl(client.url, mirror), jarPath, { onProgress });
      } catch {
        await downloadFile(rewriteUrl(client.url, 'official'), jarPath, { onProgress });
      }
    }
  }

  const libraries = collectLibraries(detail);
  log(`需要下载 ${libraries.length} 个库文件`);
  await downloadBatch(
    libraries.map((item) => ({
      url: rewriteUrl(item.url, mirror),
      fallbackUrl: rewriteUrl(item.url, 'official'),
      dest: join(targetDir, 'libraries', item.path),
      size: item.size,
    })),
    { label: '库文件', log, onProgress, concurrency: threads, attempts: LIBRARY_ATTEMPTS, idleTimeout: LIBRARY_IDLE_TIMEOUT },
  );

  if (withAssets) await downloadAssets(detail, targetDir, mirror, { log, onProgress, threads });

  return { versionId: detail.id, versionDir };
}
