import { readFile } from 'node:fs/promises';
import { sendJson, readJsonBody } from './app.js';
import { fetchVersionList } from '../core/version.js';
import { fetchLoaderVersions, LOADERS } from '../core/loader.js';
import { installLoader } from '../core/installer.js';
import { downloadVanillaGame, clampThreads } from '../core/vanilla.js';
import { MIRRORS, isUtc8, resolveMirror } from '../core/mirror.js';
import { logger } from '../utils/logger.js';

/** 读取 package.json 中的版本号，供前端页脚展示 */
const PACKAGE_INFO = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

/**
 * API 路由
 *
 * GET  /api/config                             服务端配置（默认下载源）
 * GET  /api/health                             健康检查
 * GET  /api/versions?type=release|snapshot     游戏版本列表（可带 mirror）
 * GET  /api/loader-versions?loader=&game=      加载器版本列表（可带 mirror）
 * POST /api/download                           SSE 流式下载并安装（body 可带 mirror）
 */
export async function handleApiRequest(req, res, url) {
  const key = `${req.method} ${url.pathname}`;

  switch (key) {
    case 'GET /api/config':
      sendJson(res, 200, {
        version: PACKAGE_INFO.version,
        defaultMirror: resolveMirror('auto'),
        utc8: isUtc8(),
        mirrors: MIRRORS,
      });
      return;

    case 'GET /api/health':
      sendJson(res, 200, { ok: true });
      return;

    case 'GET /api/versions':
      await handleVersions(res, url);
      return;

    case 'GET /api/loader-versions':
      await handleLoaderVersions(res, url);
      return;

    case 'POST /api/download':
      await handleDownload(req, res);
      return;

    default:
      sendJson(res, 404, { error: '接口不存在' });
  }
}

function readMirror(value) {
  return MIRRORS.includes(value) ? value : 'auto';
}

async function handleVersions(res, url) {
  const type = url.searchParams.get('type') ?? 'release';
  const mirror = readMirror(url.searchParams.get('mirror'));

  try {
    const versions = await fetchVersionList({ type, mirror });
    sendJson(res, 200, { versions });
  } catch (err) {
    sendJson(res, 502, { error: `获取游戏版本失败: ${err.message}` });
  }
}

async function handleLoaderVersions(res, url) {
  const loader = url.searchParams.get('loader');
  const game = url.searchParams.get('game');
  const mirror = readMirror(url.searchParams.get('mirror'));

  if (!LOADERS.includes(loader)) {
    sendJson(res, 400, { error: `不支持的加载器: ${loader ?? '(空)'}` });
    return;
  }
  if (!game) {
    sendJson(res, 400, { error: '缺少参数: game' });
    return;
  }

  try {
    const versions = await fetchLoaderVersions(loader, game, mirror);
    sendJson(res, 200, { versions });
  } catch (err) {
    sendJson(res, 502, { error: `获取加载器版本失败: ${err.message}` });
  }
}

/** 下载并安装，通过 SSE 推送日志、进度与结果 */
async function handleDownload(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const {
    loader = 'vanilla',
    gameVersion,
    loaderVersion,
    downloadDir = './downloads',
    gameDir = './.minecraft',
    autoInstall = true,
    mirror,
    downloadVanilla = false,
    downloadAssets = true,
    isolate = false,
    threads,
  } = body;

  const vanillaOnly = loader === 'vanilla';

  if (!vanillaOnly && !LOADERS.includes(loader)) {
    sendJson(res, 400, { error: `不支持的加载器: ${loader ?? '(空)'}` });
    return;
  }
  if (!gameVersion) {
    sendJson(res, 400, { error: '缺少参数: gameVersion' });
    return;
  }
  if (!vanillaOnly && !loaderVersion) {
    sendJson(res, 400, { error: '缺少参数: loaderVersion' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const resolvedMirror = readMirror(mirror);
  send('log', {
    message: vanillaOnly
      ? `准备下载原版（Minecraft ${gameVersion}），下载源：${resolveMirror(resolvedMirror)}`
      : `准备 ${loader} ${loaderVersion}（Minecraft ${gameVersion}），下载源：${resolveMirror(resolvedMirror)}`,
  });
  if (!vanillaOnly && downloadVanilla) {
    send('log', { message: `将下载原版游戏文件${downloadAssets ? '（含资源 assets）' : '（不含 assets）'}` });
  }
  if (isolate) send('log', { message: '安装后创建版本隔离目录' });

  try {
    if (vanillaOnly) {
      send('log', { message: `下载原版游戏文件（含${downloadAssets ? '' : '不含'}资源 assets），下载线程：${clampThreads(threads)}` });
      const result = await downloadVanillaGame(gameVersion, {
        gameDir,
        mirror: resolvedMirror,
        downloadAssets,
        threads: clampThreads(threads),
        log: (message) => send('log', { message }),
        onProgress: (progress) => send('progress', progress),
      });
      send('done', { installed: false, vanillaOnly: true, gameDir, versionId: result.versionId });
      return;
    }

    const result = await installLoader(
      {
        loader,
        gameVersion,
        loaderVersion,
        downloadDir,
        gameDir,
        autoInstall,
        mirror: resolvedMirror,
        downloadVanilla,
        downloadAssets,
        isolate,
        threads,
      },
      {
        log: (message) => send('log', { message }),
        progress: (progress) => send('progress', progress),
      },
    );
    send('done', result);
  } catch (err) {
    logger.error(`下载/安装失败: ${err.message}`);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
}
