import { join, resolve } from 'node:path';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { downloadFile, fetchExpectedSha1 } from './downloader.js';
import { resolveInstaller } from './loader.js';
import { downloadVanillaGame, clampThreads } from './vanilla.js';
import { detectJava, runJava } from './java.js';
import { logger } from '../utils/logger.js';

/** 版本隔离时在版本目录内创建的独立子目录 */
const ISOLATED_DIRS = ['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'logs'];

/**
 * 加载器安装后生成的版本 id（与安装器创建的版本目录名一致）
 * @param {string} loader
 * @param {string} gameVersion
 * @param {string} loaderVersion
 */
function loaderVersionId(loader, gameVersion, loaderVersion) {
  switch (loader) {
    case 'fabric':
      return `fabric-loader-${loaderVersion}-${gameVersion}`;
    case 'forge':
      return `${gameVersion}-forge-${loaderVersion}`;
    case 'neoforge':
      return `neoforge-${loaderVersion}`;
    default:
      return `${gameVersion}-${loader}-${loaderVersion}`;
  }
}

/**
 * 下载原版文件、下载安装器并安装加载器
 * @param {{
 *   loader: string,
 *   gameVersion: string,
 *   loaderVersion: string,
 *   downloadDir: string,
 *   gameDir: string,
 *   autoInstall: boolean,
 *   mirror?: string,
 *   downloadVanilla?: boolean,
 *   downloadAssets?: boolean,
 *   isolate?: boolean,
 *   threads?: number
 * }} options
 * @param {{ log?: (message: string) => void, progress?: Function }} [hooks]
 */
export async function installLoader(options, hooks = {}) {
  const {
    loader,
    gameVersion,
    loaderVersion,
    downloadDir,
    gameDir,
    autoInstall,
    mirror = 'auto',
    downloadVanilla = false,
    downloadAssets = true,
    isolate = false,
    threads,
  } = options;

  const log = hooks.log ?? ((message) => logger.info(message));
  const targetDir = resolve(gameDir);
  const threadCount = clampThreads(threads);

  const installer = await resolveInstaller(loader, gameVersion, loaderVersion, mirror);

  if (downloadVanilla) {
    log(`下载原版游戏文件（Minecraft ${gameVersion}），下载线程：${threadCount}`);
    await downloadVanillaGame(gameVersion, {
      gameDir: targetDir,
      mirror,
      downloadAssets,
      threads: threadCount,
      log,
      onProgress: hooks.progress,
    });
    log('原版游戏文件下载完成');
  }

  const downloadPath = resolve(downloadDir, 'installers', installer.fileName);

  log(`开始下载 ${installer.fileName}`);
  let result;
  let downloadUrl;

  for (const [index, url] of installer.urls.entries()) {
    try {
      downloadUrl = url;
      result = await downloadFile(url, downloadPath, { onProgress: hooks.progress });
      break;
    } catch (err) {
      if (index === installer.urls.length - 1) throw err;
      log(`下载源不可用（${err.message}），尝试备用源`);
    }
  }

  log(`下载完成（${(result.size / 1024 / 1024).toFixed(2)} MB）`);

  const expectedSha1 = await fetchExpectedSha1(downloadUrl);
  if (expectedSha1) {
    if (result.sha1 !== expectedSha1) {
      await rm(downloadPath, { force: true });
      throw new Error('安装器 sha1 校验失败，已删除下载文件');
    }
    log('sha1 校验通过');
  }

  if (!autoInstall) {
    return { installer: downloadPath, installed: false };
  }

  await mkdir(targetDir, { recursive: true });
  await ensureLauncherProfiles(targetDir, log);

  const javaPath = await detectJava();
  log(`使用 Java: ${javaPath}`);
  log(`开始安装到 ${targetDir}`);

  await runJava(javaPath, ['-jar', downloadPath, ...installer.args(targetDir)], { onLog: log });

  log('安装完成');

  const versionId = loaderVersionId(loader, gameVersion, loaderVersion);
  let isolatedDir = null;

  // 把原版 json 与加载器 json 合并成自包含版本，client.jar 也放进同一目录
  const merged = await mergeIntoLoaderFolder(targetDir, versionId, gameVersion, log);

  if (isolate) {
    isolatedDir = await createIsolatedDirs(targetDir, versionId, log);
    await registerProfile(targetDir, versionId, isolatedDir);
  }

  return {
    installer: downloadPath,
    installed: true,
    gameDir: targetDir,
    versionId,
    isolatedDir,
    merged,
  };
}

/**
 * 将加载器版本与原版版本合并到同一个版本目录：
 * versions/<加载器版本>/ 内包含自包含的 <加载器版本>.json 与 <加载器版本>.jar
 * 合并规则为本项目自行实现，仅沿用常见启动器的目录组织习惯，未复制 PCL 代码
 */
async function mergeIntoLoaderFolder(targetDir, loaderId, gameVersion, log) {
  const versionsDir = join(targetDir, 'versions');
  const loaderJsonPath = join(versionsDir, loaderId, `${loaderId}.json`);
  const vanillaJsonPath = join(versionsDir, gameVersion, `${gameVersion}.json`);

  let loaderJson;
  let vanillaJson;
  try {
    loaderJson = JSON.parse(await readFile(loaderJsonPath, 'utf8'));
    vanillaJson = JSON.parse(await readFile(vanillaJsonPath, 'utf8'));
  } catch {
    log('未找到原版版本 json，跳过版本合并（如需合并请勾选“下载原版游戏”）');
    return false;
  }

  if (loaderJson.inheritsFrom !== gameVersion) {
    log(`版本 ${loaderId} 已自包含，无需合并`);
    return false;
  }

  const merged = {
    ...vanillaJson,
    ...loaderJson,
    id: loaderId,
    libraries: mergeLibraries(loaderJson.libraries, vanillaJson.libraries),
    arguments: mergeArguments(vanillaJson.arguments, loaderJson.arguments),
  };
  delete merged.inheritsFrom;

  if (!loaderJson.minecraftArguments && vanillaJson.minecraftArguments) {
    merged.minecraftArguments = vanillaJson.minecraftArguments;
  }
  if (!merged.arguments?.game?.length && !merged.arguments?.jvm?.length) delete merged.arguments;

  await writeFile(loaderJsonPath, JSON.stringify(merged, null, 2), 'utf8');

  const vanillaJar = join(versionsDir, gameVersion, `${gameVersion}.jar`);
  const loaderJar = join(versionsDir, loaderId, `${loaderId}.jar`);
  try {
    await copyFile(vanillaJar, loaderJar);
  } catch {
    log('未找到原版 client.jar，版本目录内可能缺少游戏本体');
  }

  log(`已将原版与加载器合并到 versions/${loaderId}（json + jar 同一目录）`);

  await pruneVanillaVersion(targetDir, gameVersion, loaderId, log);
  return true;
}

/** 合并库列表：加载器优先，按 group:artifact:classifier 去重 */
function mergeLibraries(loaderLibraries = [], vanillaLibraries = []) {
  const seen = new Set();
  const libraries = [];

  for (const library of [...loaderLibraries, ...vanillaLibraries]) {
    const [group, artifact, , classifier = ''] = (library?.name ?? '').split(':');
    const key = `${group}:${artifact}:${classifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    libraries.push(library);
  }

  return libraries;
}

/** 合并启动参数：原版参数在前，加载器参数在后（与版本继承的语义一致） */
function mergeArguments(vanillaArguments = {}, loaderArguments = {}) {
  return {
    game: [...(vanillaArguments.game ?? []), ...(loaderArguments.game ?? [])],
    jvm: [...(vanillaArguments.jvm ?? []), ...(loaderArguments.jvm ?? [])],
  };
}

/**
 * 合并完成后移除原版版本目录；若仍有版本继承它或启动器配置引用它则保留
 */
async function pruneVanillaVersion(targetDir, gameVersion, mergedId, log) {
  const versionsDir = join(targetDir, 'versions');
  const entries = await readdir(versionsDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === gameVersion || entry.name === mergedId) continue;
    try {
      const other = JSON.parse(
        await readFile(join(versionsDir, entry.name, `${entry.name}.json`), 'utf8'),
      );
      if (other.inheritsFrom === gameVersion) return;
    } catch {
      // 忽略无法解析的版本 json
    }
  }

  try {
    const profiles = JSON.parse(
      await readFile(join(targetDir, 'launcher_profiles.json'), 'utf8'),
    );
    const referenced = Object.values(profiles.profiles ?? {}).some(
      (profile) => profile?.lastVersionId === gameVersion,
    );
    if (referenced) return;
  } catch {
    // launcher_profiles.json 不存在时忽略
  }

  await rm(join(versionsDir, gameVersion), { recursive: true, force: true });
  log(`已移除单独的原版版本目录 versions/${gameVersion}`);
}

/** 创建版本隔离目录，让 mods / saves / config 等按版本独立存放 */
async function createIsolatedDirs(targetDir, versionId, log) {
  const dir = join(targetDir, 'versions', versionId);
  await mkdir(dir, { recursive: true });
  await Promise.all(ISOLATED_DIRS.map((sub) => mkdir(join(dir, sub), { recursive: true })));
  log(`已创建版本隔离目录 versions/${versionId}（mods / saves / config 独立）`);
  return dir;
}

/** 在 launcher_profiles.json 中记录该版本的独立游戏目录 */
async function registerProfile(targetDir, versionId, gameDir) {
  const profilePath = join(targetDir, 'launcher_profiles.json');
  let data;

  try {
    data = JSON.parse(await readFile(profilePath, 'utf8'));
  } catch {
    data = { profiles: {}, settings: {}, version: 3 };
  }

  data.profiles ??= {};

  const existingKey = Object.keys(data.profiles).find(
    (key) => data.profiles[key]?.lastVersionId === versionId,
  );
  const key = existingKey ?? versionId;
  const current = data.profiles[key] ?? {};

  data.profiles[key] = {
    ...current,
    name: current.name ?? versionId,
    type: current.type ?? 'custom',
    lastVersionId: versionId,
    gameDir,
  };

  await writeFile(profilePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 安装器要求游戏目录中存在 launcher_profiles.json，缺失时创建一个空文件
 * （HMCL / PCL 同样会做这一步）
 */
async function ensureLauncherProfiles(targetDir, log) {
  const profilePath = join(targetDir, 'launcher_profiles.json');
  try {
    await access(profilePath);
  } catch {
    await writeFile(
      profilePath,
      JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
      'utf8',
    );
    log('已创建 launcher_profiles.json');
  }
}
