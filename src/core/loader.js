import { fetchJson, fetchText } from '../utils/http.js';
import { getEndpoints, resolveMirror } from './mirror.js';

/** 支持的加载器 */
export const LOADERS = ['fabric', 'forge', 'neoforge'];

const CACHE_TTL = 10 * 60 * 1000;
const versionCache = new Map();
const metadataCache = new Map();
const installerCache = new Map();

async function cached(map, key, loader) {
  const hit = map.get(key);
  if (hit) {
    // 同一请求正在加载时直接复用，避免并发重复拉取上游元数据
    if (hit.pending) return hit.pending;
    if (Date.now() - hit.time < CACHE_TTL) return hit.data;
  }

  const pending = loader()
    .then((data) => {
      map.set(key, { time: Date.now(), data });
      return data;
    })
    .catch((err) => {
      map.delete(key);
      throw err;
    });

  map.set(key, { pending });
  return pending;
}

/**
 * 获取指定游戏版本可用的加载器版本
 * @param {'fabric' | 'forge' | 'neoforge'} loader
 * @param {string} gameVersion
 * @param {string} [mirror]
 * @returns {Promise<Array<{ version: string, stable: boolean }>>}
 */
export async function fetchLoaderVersions(loader, gameVersion, mirror = 'auto') {
  if (!LOADERS.includes(loader)) throw new Error(`不支持的加载器: ${loader}`);

  const cacheKey = `${resolveMirror(mirror)}:${loader}:${gameVersion}`;
  return cached(versionCache, cacheKey, () =>
    loadLoaderVersions(loader, gameVersion, mirror));
}

async function loadLoaderVersions(loader, gameVersion, mirror) {
  switch (loader) {
    case 'fabric':
      return fetchFabricLoaders(mirror, gameVersion);
    case 'forge':
      return fetchForgeLoaders(mirror, gameVersion);
    case 'neoforge':
      return fetchNeoForgeLoaders(mirror, gameVersion);
    default:
      throw new Error(`不支持的加载器: ${loader}`);
  }
}

/**
 * 解析安装器下载地址与启动参数
 * @param {string} loader
 * @param {string} gameVersion
 * @param {string} loaderVersion
 * @param {string} [mirror]
 */
export async function resolveInstaller(loader, gameVersion, loaderVersion, mirror = 'auto') {
  const endpoints = getEndpoints(mirror);
  const alternate = getEndpoints(resolveMirror(mirror) === 'bmclapi' ? 'official' : 'bmclapi');

  switch (loader) {
    case 'fabric': {
      const installers = await cached(
        installerCache,
        `fabric-installer:${endpoints.name}`,
        () => fetchJson(`${endpoints.fabricMeta}/versions/installer`),
      );
      const latest = installers.find((item) => item.stable) ?? installers[0];
      if (!latest) throw new Error('无法获取 Fabric 安装器版本');
      const version = latest.version;
      const path = `net/fabricmc/fabric-installer/${version}/fabric-installer-${version}.jar`;

      return {
        // BMCLAPI 的 Maven 镜像不包含 fabric-installer，优先走官方 Maven
        urls: [`${getEndpoints('official').fabricMaven}/${path}`, `${endpoints.fabricMaven}/${path}`],
        fileName: `fabric-installer-${version}.jar`,
        args: (gameDir) => ['client', '-dir', gameDir, '-mcversion', gameVersion, '-loader', loaderVersion],
      };
    }

    case 'forge': {
      const fullVersion = `${gameVersion}-${loaderVersion}`;
      const path = `${fullVersion}/forge-${fullVersion}-installer.jar`;
      return {
        urls: [`${endpoints.forgeMaven}/${path}`, `${alternate.forgeMaven}/${path}`],
        fileName: `forge-${fullVersion}-installer.jar`,
        args: (gameDir) => ['--installClient', gameDir],
      };
    }

    case 'neoforge': {
      const path = `${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
      return {
        urls: [`${endpoints.neoforgeMaven}/${path}`, `${alternate.neoforgeMaven}/${path}`],
        fileName: `neoforge-${loaderVersion}-installer.jar`,
        args: (gameDir) => ['--installClient', gameDir],
      };
    }

    default:
      throw new Error(`不支持的加载器: ${loader}`);
  }
}

/** Fabric：官方 meta API 直接给出该游戏版本的加载器列表 */
async function fetchFabricLoaders(mirror, gameVersion) {
  const endpoints = getEndpoints(mirror);
  const data = await fetchJson(`${endpoints.fabricMeta}/versions/loader/${encodeURIComponent(gameVersion)}`);
  return data
    .map((item) => ({ version: item.loader.version, stable: item.loader.stable }))
    .filter((item) => item.version);
}

/** 从 Maven 的 maven-metadata.xml 中提取版本号 */
function extractVersions(xml) {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
}

/** Maven 元数据偶发连接失败，适当重试；单次超时比清单下载更短，避免长时间卡在单个源 */
const METADATA_OPTIONS = { timeout: 20_000, attempts: 3 };

/**
 * 获取 Maven 元数据（带缓存与镜像回退）
 * 下载源偶发失败时自动尝试另一个源，避免页面长时间无响应
 * @param {'forge' | 'neoforge'} kind
 * @param {string} mirror
 */
async function fetchMetadata(kind, mirror) {
  const primary = getEndpoints(mirror);
  const fallback = getEndpoints(resolveMirror(mirror) === 'bmclapi' ? 'official' : 'bmclapi');
  const baseOf = (endpoints) => (kind === 'forge' ? endpoints.forgeMaven : endpoints.neoforgeMaven);

  return cached(metadataCache, `${primary.name}:${kind}`, async () => {
    try {
      return await fetchText(`${baseOf(primary)}/maven-metadata.xml`, METADATA_OPTIONS);
    } catch {
      return fetchText(`${baseOf(fallback)}/maven-metadata.xml`, METADATA_OPTIONS);
    }
  });
}

/**
 * 预热加载器元数据缓存（Fabric 安装器列表 + Forge / NeoForge 的 Maven 元数据）
 * Maven 元数据体积较大且首次拉取较慢，提前加载可显著缩短页面等待时间
 */
export async function warmLoaderCache(mirror = 'auto') {
  const endpoints = getEndpoints(mirror);

  await Promise.allSettled([
    cached(installerCache, `fabric-installer:${endpoints.name}`, () =>
      fetchJson(`${endpoints.fabricMeta}/versions/installer`)),
    fetchMetadata('forge', mirror),
    fetchMetadata('neoforge', mirror),
  ]);
}

/** Forge：版本号形如 1.20.1-47.2.0 */
async function fetchForgeLoaders(mirror, gameVersion) {
  const xml = await fetchMetadata('forge', mirror);
  const prefix = `${gameVersion}-`;

  return extractVersions(xml)
    .filter((version) => version.startsWith(prefix))
    .map((version) => ({ version: version.slice(prefix.length), stable: true }))
    .reverse();
}

/** NeoForge 版本号与游戏版本对应：1.20.2 -> 20.2.x，1.21.1 -> 21.1.x */
function neoforgePrefix(gameVersion) {
  const [, minor, patch = '0'] = gameVersion.split('.');
  const minorNumber = Number(minor);
  const patchNumber = Number(patch);

  if (!minor || Number.isNaN(minorNumber) || Number.isNaN(patchNumber)) return null;
  if (minorNumber < 20) return null;
  if (minorNumber === 20 && patchNumber < 2) return null;

  return `${minor}.${patch}.`;
}

/** NeoForge：1.20.2 起才提供，早期版本返回空列表 */
async function fetchNeoForgeLoaders(mirror, gameVersion) {
  const prefix = neoforgePrefix(gameVersion);
  if (!prefix) return [];

  const xml = await fetchMetadata('neoforge', mirror);
  return extractVersions(xml)
    .filter((version) => version.startsWith(prefix))
    .map((version) => ({ version, stable: true }))
    .reverse();
}
