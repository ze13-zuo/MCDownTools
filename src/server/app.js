import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './router.js';
import { logger } from '../utils/logger.js';

/** 前端静态资源目录 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** 创建应用服务器：API 请求交给 router，其余按静态文件处理 */
export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, url);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      logger.error(`请求处理失败: ${err.message}`);
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  });
}

async function serveStatic(pathname, res) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(join(PUBLIC_DIR, relativePath));

  // 防止路径穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let content;
  try {
    content = await readFile(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

/** 统一的 JSON 响应 */
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 读取 JSON 请求体 */
export function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}
