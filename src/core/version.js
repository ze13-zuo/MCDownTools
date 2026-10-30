import { fetchJson } from '../utils/http.js';
import { getEndpoints } from './mirror.js';

const CACHE_TTL = 10 * 60 * 1000;

/** 按清单地址缓存，官方源与镜像互不影响 */
const manifestCache = new Map();

async function loadManifest(url) {
  const hit = manifestCache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;

  const data = await fetchJson(url);
  manifestCache.set(url, { time: Date.now(), data });
  return data;
}

/**
 * 获取游戏版本列表
 * @param {{ type?: 'release' | 'snapshot' | 'all', mirror?: string }} [options]
 * @returns {Promise<Array<{ id: string, type: string, releaseTime: string }>>}
 */
export async function fetchVersionList({ type = 'release', mirror = 'auto' } = {}) {
  const endpoints = getEndpoints(mirror);
  const manifest = await loadManifest(endpoints.manifest);
  const versions = type === 'all'
    ? manifest.versions
    : manifest.versions.filter((item) => item.type === type);

  return versions.map(({ id, type: versionType, releaseTime }) => ({
    id,
    type: versionType,
    releaseTime,
  }));
}

/** 预热版本清单缓存，启动时调用可避免首次请求等待 */
export async function warmVersionCache(mirror = 'auto') {
  return loadManifest(getEndpoints(mirror).manifest);
}

/**
 * 获取单个游戏版本的详情
 * @param {string} id
 * @param {string} [mirror]
 */
export async function fetchVersionDetail(id, mirror = 'auto') {
  const endpoints = getEndpoints(mirror);
  const manifest = await loadManifest(endpoints.manifest);
  const entry = manifest.versions.find((item) => item.id === id);
  if (!entry) throw new Error(`未找到游戏版本: ${id}`);
  return fetchJson(entry.url);
}
