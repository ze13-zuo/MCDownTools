/**
 * 下载源（镜像）配置
 *
 * BMCLAPI 文档：https://bmclapi2.bangbang93.com/
 * - 版本清单：/mc/game/version_manifest_v2.json
 * - Fabric meta：/fabric-meta
 * - Maven（Fabric / Forge / NeoForge）：/maven
 */

const OFFICIAL_ENDPOINTS = {
  name: 'official',
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://meta.fabricmc.net/v2',
  fabricMaven: 'https://maven.fabricmc.net',
  forgeMaven: 'https://maven.minecraftforge.net/net/minecraftforge/forge',
  neoforgeMaven: 'https://maven.neoforged.net/releases/net/neoforged/neoforge',
};

const BMCLAPI_ENDPOINTS = {
  name: 'bmclapi',
  manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://bmclapi2.bangbang93.com/fabric-meta/v2',
  fabricMaven: 'https://bmclapi2.bangbang93.com/maven',
  forgeMaven: 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge',
  neoforgeMaven: 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge',
};

/** BMCLAPI 文档要求的 URL 前缀替换 */
const URL_REWRITES = [
  ['https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven'],
  ['https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets'],
  ['http://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets'],
];

/** 支持的下载源设置 */
export const MIRRORS = ['auto', 'bmclapi', 'official'];

/** 当前系统时区是否为 UTC+8 */
export function isUtc8() {
  return -new Date().getTimezoneOffset() === 480;
}

/**
 * 将 auto 解析为具体镜像：UTC+8 默认使用 BMCLAPI，其余使用官方源
 * @param {string} mirror
 * @returns {'bmclapi' | 'official'}
 */
export function resolveMirror(mirror) {
  if (mirror === 'bmclapi' || mirror === 'official') return mirror;
  return isUtc8() ? 'bmclapi' : 'official';
}

/**
 * 获取镜像对应的各接口地址
 * @param {string} mirror
 */
export function getEndpoints(mirror) {
  return resolveMirror(mirror) === 'bmclapi' ? BMCLAPI_ENDPOINTS : OFFICIAL_ENDPOINTS;
}

/**
 * 将 Mojang 资源地址改写为镜像地址（版本 json 内的 client.jar / libraries / assets）
 * @param {string} url
 * @param {string} mirror
 */
export function rewriteUrl(url, mirror) {
  if (resolveMirror(mirror) !== 'bmclapi') return url;

  for (const [from, to] of URL_REWRITES) {
    if (url.startsWith(from)) return `${to}${url.slice(from.length)}`;
  }
  return url;
}
