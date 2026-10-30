const elements = {
  form: document.getElementById('download-form'),
  loader: document.getElementById('loader'),
  mirror: document.getElementById('mirror'),
  mirrorHint: document.getElementById('mirror-hint'),
  versionType: document.getElementById('version-type'),
  gameVersion: document.getElementById('game-version'),
  loaderVersion: document.getElementById('loader-version'),
  loaderVersionRow: document.getElementById('loader-version-row'),
  downloadVanillaRow: document.getElementById('download-vanilla-row'),
  isolateRow: document.getElementById('isolate-row'),
  autoInstallRow: document.getElementById('auto-install-row'),
  downloadDir: document.getElementById('download-dir'),
  gameDir: document.getElementById('game-dir'),
  threads: document.getElementById('threads'),
  autoInstall: document.getElementById('auto-install'),
  downloadVanilla: document.getElementById('download-vanilla'),
  isolate: document.getElementById('isolate'),
  submit: document.getElementById('submit'),
  refresh: document.getElementById('refresh'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  toasts: document.getElementById('toasts'),
  themeToggle: document.getElementById('theme-toggle'),
  appVersion: document.getElementById('app-version'),
};

/** 弹窗显示时长（毫秒） */
const TOAST_DURATION = 5000;
const THEME_KEY = 'mcdown-theme';

let busy = false;
let loaderRequestId = 0;
let serverConfig = { defaultMirror: 'official', utc8: false };

/** 当前实际使用的下载源 */
function currentMirror() {
  return elements.mirror.value === 'auto' ? serverConfig.defaultMirror : elements.mirror.value;
}

function updateMirrorHint() {
  const resolved = currentMirror();
  if (elements.mirror.value === 'auto') {
    elements.mirrorHint.textContent = serverConfig.utc8
      ? '检测到 UTC+8 时区，已自动使用 BMCLAPI 镜像。'
      : '当前时区非 UTC+8，使用官方源。';
  } else if (resolved === 'bmclapi') {
    elements.mirrorHint.textContent = '正在使用 BMCLAPI 镜像加速，资源版权归原站点所有。';
  } else {
    elements.mirrorHint.textContent = '正在使用官方源，国内网络可能较慢。';
  }
}

/** 右下角弹窗提示，5 秒后自动消失；新消息显示在老消息上方 */
function notify(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  elements.toasts.prepend(toast);

  setTimeout(() => {
    toast.classList.add('toast--out');
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

/** 应用主题：light / dark */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.textContent = theme === 'light' ? '暗色模式' : '亮色模式';
}

/** 初始化主题：读取本地记录，默认暗色 */
function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
  elements.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function setProgress(percent, text) {
  const value = Math.max(0, Math.min(100, percent));
  elements.progressBar.style.width = `${value}%`;
  elements.progressText.textContent = text ?? `${value}%`;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data;
}

function setSelectMessage(select, message) {
  select.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = message;
  select.appendChild(option);
  select.disabled = true;
}

function addOption(select, value, label = value) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

/** 是否仅下载原版（不安装加载器） */
function isVanillaMode() {
  return elements.loader.value === 'vanilla';
}

/** 原版模式下隐藏加载器相关选项，并同步复选框状态 */
function syncLoaderMode() {
  const vanilla = isVanillaMode();
  elements.loaderVersionRow.style.display = vanilla ? 'none' : '';
  elements.autoInstallRow.style.display = vanilla ? 'none' : '';
  elements.isolateRow.style.display = vanilla ? 'none' : '';
  elements.downloadVanillaRow.style.display = vanilla ? 'none' : '';

  if (vanilla) {
    elements.downloadVanilla.checked = true;
    setSelectMessage(elements.loaderVersion, '原版无需加载器版本');
    return;
  }

  loadLoaderVersions();
}

/** 加载游戏版本列表 */
async function loadGameVersions() {
  const type = elements.versionType.value;
  setSelectMessage(elements.gameVersion, '加载中...');
  setSelectMessage(elements.loaderVersion, '请先选择游戏版本');

  try {
    const { versions } = await request(`/api/versions?type=${type}&mirror=${elements.mirror.value}`);
    const previous = elements.gameVersion.value;

    elements.gameVersion.innerHTML = '';
    for (const item of versions) addOption(elements.gameVersion, item.id);
    elements.gameVersion.disabled = versions.length === 0;

    const keepPrevious = versions.some((item) => item.id === previous);
    if (keepPrevious) elements.gameVersion.value = previous;

    notify(`已加载 ${versions.length} 个游戏版本`);
  } catch (err) {
    setSelectMessage(elements.gameVersion, '加载失败');
    notify(`加载游戏版本失败: ${err.message}`, 'error');
    return;
  }

  await loadLoaderVersions();
}

/** 加载当前加载器在所选游戏版本下的可用版本 */
async function loadLoaderVersions() {
  const loader = elements.loader.value;
  const game = elements.gameVersion.value;
  const requestId = (loaderRequestId += 1);

  if (isVanillaMode()) {
    setSelectMessage(elements.loaderVersion, '原版无需加载器版本');
    return;
  }

  if (!game) {
    setSelectMessage(elements.loaderVersion, '请先选择游戏版本');
    return;
  }

  setSelectMessage(elements.loaderVersion, '加载中...');

  try {
    const { versions } = await request(
      `/api/loader-versions?loader=${loader}&game=${encodeURIComponent(game)}&mirror=${elements.mirror.value}`,
    );
    if (requestId !== loaderRequestId) return;

    elements.loaderVersion.innerHTML = '';
    if (!versions.length) {
      setSelectMessage(elements.loaderVersion, `暂无 ${game} 的可用版本`);
      notify(`${loader} 暂不支持游戏版本 ${game}`, 'error');
      return;
    }

    for (const item of versions) {
      addOption(elements.loaderVersion, item.version, item.stable ? `${item.version}（稳定）` : item.version);
    }
    elements.loaderVersion.disabled = false;
    notify(`已加载 ${versions.length} 个 ${loader} 版本`);
  } catch (err) {
    if (requestId !== loaderRequestId) return;
    setSelectMessage(elements.loaderVersion, '加载失败');
    notify(`加载加载器版本失败: ${err.message}`, 'error');
  }
}

/** 解析单条 SSE 事件 */
function parseSseEvent(raw) {
  let name = 'message';
  const dataLines = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (!dataLines.length) return null;
  try {
    return { name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/** 通过 fetch 读取服务端 SSE 流 */
async function streamDownload(payload, onEvent) {
  const response = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `请求失败 (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const event = parseSseEvent(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      if (event) onEvent(event);
      index = buffer.indexOf('\n\n');
    }
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (busy) return;

  const vanillaMode = isVanillaMode();

  const payload = {
    loader: elements.loader.value,
    gameVersion: elements.gameVersion.value,
    loaderVersion: vanillaMode ? '' : elements.loaderVersion.value,
    downloadDir: elements.downloadDir.value.trim(),
    gameDir: elements.gameDir.value.trim(),
    autoInstall: vanillaMode ? false : elements.autoInstall.checked,
    downloadVanilla: vanillaMode ? true : elements.downloadVanilla.checked,
    isolate: vanillaMode ? false : elements.isolate.checked,
    mirror: elements.mirror.value,
    threads: Math.min(128, Math.max(1, Number(elements.threads.value) || 32)),
  };

  if (!payload.gameVersion) {
    notify('请选择游戏版本', 'error');
    return;
  }
  if (!vanillaMode && !payload.loaderVersion) {
    notify('请选择加载器版本', 'error');
    return;
  }

  busy = true;
  elements.submit.disabled = true;
  elements.submit.textContent = '处理中...';
  setProgress(0, '准备中...');
  notify(
    vanillaMode
      ? `开始下载原版（Minecraft ${payload.gameVersion}）`
      : `开始 ${payload.loader} ${payload.loaderVersion}（Minecraft ${payload.gameVersion}）`,
  );

  let failedMessage = null;

  try {
    await streamDownload(payload, ({ name, data }) => {
      if (name === 'log') notify(data.message);
      else if (name === 'progress') setProgress(data.percent, `下载 ${data.fileName} ${data.percent}%`);
      else if (name === 'done') {
        setProgress(100, '完成');
        if (data.vanillaOnly) notify(`原版下载完成：versions/${data.versionId}`, 'success');
        else notify(data.installed ? `已安装到 ${data.gameDir}` : `安装器已保存到 ${data.installer}`, 'success');
        if (data.isolatedDir) notify(`版本隔离目录: ${data.isolatedDir}`, 'success');
      } else if (name === 'error') {
        failedMessage = data.message;
      }
    });

    if (failedMessage) throw new Error(failedMessage);
    notify('任务结束');
  } catch (err) {
    setProgress(0, '失败');
    notify(`失败: ${err.message}`, 'error');
  } finally {
    busy = false;
    elements.submit.disabled = false;
    elements.submit.textContent = '开始下载';
  }
}

elements.form.addEventListener('submit', handleSubmit);
elements.loader.addEventListener('change', syncLoaderMode);
elements.mirror.addEventListener('change', () => {
  updateMirrorHint();
  loadGameVersions();
});
elements.gameVersion.addEventListener('change', loadLoaderVersions);
elements.versionType.addEventListener('change', loadGameVersions);
elements.refresh.addEventListener('click', loadGameVersions);

async function init() {
  initTheme();
  notify('页面已就绪');
  try {
    serverConfig = await request('/api/config');
    if (serverConfig.version) elements.appVersion.textContent = `MCDownTools v${serverConfig.version}`;
  } catch (err) {
    notify(`读取服务配置失败: ${err.message}`, 'error');
  }

  const defaultLabel = serverConfig.defaultMirror === 'bmclapi' ? 'BMCLAPI' : '官方源';
  elements.mirror.options[0].textContent = `自动（当前 ${defaultLabel}）`;
  updateMirrorHint();
  await loadGameVersions();
}

init();
