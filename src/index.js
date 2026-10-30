import { createAppServer } from './server/app.js';
import { warmVersionCache } from './core/version.js';
import { warmLoaderCache } from './core/loader.js';
import { resolveMirror } from './core/mirror.js';
import { logger } from './utils/logger.js';

const port = Number(process.env.PORT ?? 11459);
const host = process.env.HOST ?? '127.0.0.1';
const WARM_INTERVAL = 8 * 60 * 1000;

const server = createAppServer();

let warming = false;

/** 预热元数据缓存，避免用户首次请求等待上游（Forge / NeoForge 的 Maven 元数据较慢） */
async function warmCaches(reason) {
  if (warming) return;
  warming = true;

  const started = Date.now();
  const mirror = resolveMirror('auto');

  try {
    await Promise.allSettled([warmVersionCache(mirror), warmLoaderCache(mirror)]);
    logger.info(`元数据${reason}完成（${Date.now() - started}ms，下载源: ${mirror}）`);
  } finally {
    warming = false;
  }
}

server.listen(port, host, () => {
  logger.info(`MCDownTools 已启动: http://${host}:${port}`);
  warmCaches('预热');
});

setInterval(() => warmCaches('刷新'), WARM_INTERVAL).unref();

function shutdown() {
  logger.info('正在关闭服务...');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  logger.error(`未捕获的异步异常: ${reason}`);
});
