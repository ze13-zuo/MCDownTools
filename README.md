# MCDownTools

基于 Node.js + HTML 的 Minecraft 加载器下载与安装工具，支持 **Fabric / Forge / NeoForge**。按游戏版本自动列出可用加载器版本，下载官方安装器并调用本机 Java 完成安装（参考 HMCL / PCL 的做法）。
(依旧vibe coding的小左ze13)
## 环境要求

- Node.js >= 18
- 无第三方依赖（服务端使用 Node 内置 `http` 模块）
- 自动安装需要本机 Java：Minecraft 1.17+ 建议 JDK 17，1.21+ 建议 JDK 21

## 快速开始

使用启动脚本，无需手动输入命令：

| 平台 | 脚本 | 说明 |
| --- | --- | --- |
| Windows | `start.bat` | 双击运行，或在终端执行 `start.bat` |
| Linux / macOS | `start.sh` | 首次使用请先执行 `chmod +x start.sh`，再运行 `./start.sh` |

也可以用 npm：

```bash
npm start        # 启动服务
npm run dev      # 开发模式，文件变更自动重启
```

浏览器打开 <http://127.0.0.1:11459> 即可访问页面。

可通过环境变量调整监听地址：

```bash
PORT=3000 HOST=0.0.0.0 npm start
```

## 使用说明

1. 选择下载源：默认“自动”，检测到 UTC+8 时区时使用 BMCLAPI 镜像，也可手动切换为 BMCLAPI 或官方源。
2. 选择加载器（Fabric / Forge / NeoForge）与游戏版本，页面会自动加载对应加载器版本。
   只想下载游戏本体时，加载器选择「原版（仅下载游戏本体）」：会自动隐藏加载器版本、下载后安装、版本隔离等选项，只下载原版 json、`client.jar`、库文件与资源。
3. 设置下载目录（默认 `./downloads`，安装器存放在 `downloads/installers/`）和游戏目录（默认 `./.minecraft`）。
4. 设置“下载线程”（默认 32，范围 1–128）：同时下载的文件数，线程越多越快，但占用更多连接与带宽。
5. “下载原版游戏”（默认开启）：补齐原版 `versions/<版本>/<版本>.json`、`client.jar`、`libraries/`、`assets/`，不再只有版本 json。
6. 安装完成后会把原版版本与加载器版本**合并到同一个版本目录**：`versions/<加载器版本>/` 内同时包含自包含的 `<加载器版本>.json` 与 `<加载器版本>.jar`，并移除不再被引用的 `versions/<游戏版本>/`（库文件与 assets 仍共用，避免重复占空间）。
7. “版本隔离”（默认开启）：在上面这个版本目录内创建 `mods / config / saves / resourcepacks / shaderpacks / logs`，并把该目录写入 `launcher_profiles.json` 的 `gameDir`。
8. 勾选“下载后安装”后，服务端会调用 Java 执行安装器；取消勾选则只下载安装器 jar。
9. 下载与安装过程通过右下角弹窗提示（每条显示 5 秒，新消息在旧消息上方），进度显示在进度条。
10. 右上角可切换亮色 / 暗色模式，选择会记录在浏览器本地。

### 安装后的版本目录

```
.minecraft/
├── versions/
│   └── fabric-loader-0.20.1-1.20.1/
│       ├── fabric-loader-0.20.1-1.20.1.json   # 原版 + 加载器合并后的自包含 json
│       ├── fabric-loader-0.20.1-1.20.1.jar    # 原版 client.jar（与加载器同目录）
│       ├── mods/  config/  saves/  ...        # 版本隔离目录
├── libraries/                                 # 所有版本共用
└── assets/                                    # 所有版本共用
```

合并规则（库合并去重、启动参数拼接、`inheritsFrom` 展开）由本项目自行实现，仅沿用常见启动器的目录组织习惯，未复制 PCL 的代码，项目仍为 MIT License。

## 数据来源

| 加载器 | 版本列表 | 安装器 |
| --- | --- | --- |
| 游戏本体 | Mojang `version_manifest_v2.json` | - |
| Fabric | `meta.fabricmc.net` | `maven.fabricmc.net` |
| Forge | `maven.minecraftforge.net` 的 `maven-metadata.xml` | 同仓库 installer jar |
| NeoForge | `maven.neoforged.net` 的 `maven-metadata.xml` | 同仓库 installer jar |

安装器下载后会额外获取对应的 `.sha1` 文件进行完整性校验。

### BMCLAPI 镜像

国内网络环境（UTC+8 时区）默认使用 [BMCLAPI](https://bmclapi2.bangbang93.com/) 加速，映射关系参考其官方文档：

| 官方地址 | BMCLAPI 地址 |
| --- | --- |
| `piston-meta.mojang.com/mc/game/version_manifest_v2.json` | `bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json` |
| `meta.fabricmc.net/v2` | `bmclapi2.bangbang93.com/fabric-meta/v2` |
| `maven.fabricmc.net` / `maven.minecraftforge.net` | `bmclapi2.bangbang93.com/maven` |
| `maven.neoforged.net/releases/net/neoforged/neoforge` | `bmclapi2.bangbang93.com/maven/net/neoforged/neoforge` |
| `launchermeta.mojang.com` / `launcher.mojang.com` / `piston-meta.mojang.com` / `piston-data.mojang.com` | `bmclapi2.bangbang93.com` |
| `libraries.minecraft.net` | `bmclapi2.bangbang93.com/maven` |
| `resources.download.minecraft.net` | `bmclapi2.bangbang93.com/assets` |

使用镜像时的补充说明：

- BMCLAPI 的 Maven 镜像不包含 `fabric-installer`，Fabric 安装器会自动改用官方 `maven.fabricmc.net` 下载。
- Maven 元数据（Forge / NeoForge 版本列表）偶发连接失败时会自动回退到另一个下载源，避免页面长时间卡在“加载中”。
- 服务启动时会在后台预热版本清单与加载器元数据，并将结果缓存 10 分钟（每 8 分钟刷新），因此首次打开页面与切换游戏版本都很快。
- BMCLAPI 不保证提供 `.sha1`，缺失时会自动跳过完整性校验。按要求，页面会在使用 BMCLAPI 时标注资源来源。

## 目录结构

```
MCDownTools/
├── public/                    # 前端静态页面
│   ├── index.html
│   └── assets/
│       ├── style.css
│       └── app.js             # 页面逻辑，调用后端 API
├── src/
│   ├── index.js               # 服务启动入口
│   ├── server/
│   │   ├── app.js             # HTTP 服务、静态资源、请求体解析
│   │   └── router.js          # API 路由与 SSE 推送
│   ├── core/
│   │   ├── version.js         # Mojang 游戏版本
│   │   ├── loader.js          # 各加载器版本与安装器地址
│   │   ├── downloader.js      # 文件下载、进度与 sha1
│   │   ├── installer.js       # 下载 + 安装流程编排
│   │   └── java.js            # Java 检测与安装器执行
│   └── utils/
│       ├── http.js            # fetch 封装
│       └── logger.js          # 日志输出
├── start.bat                  # Windows 启动脚本
├── start.sh                   # Linux / macOS 启动脚本
├── LICENSE                    # MIT License
├── package.json
└── README.md
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 返回默认下载源（按服务端时区判断） |
| GET | `/api/health` | 健康检查 |
| GET | `/api/versions?type=release\|snapshot&mirror=auto\|bmclapi\|official` | 获取游戏版本列表 |
| GET | `/api/loader-versions?loader=fabric\|forge\|neoforge&game=1.20.1&mirror=...` | 获取指定游戏版本的加载器版本 |
| POST | `/api/download` | 下载并安装，返回 SSE 流 |

`POST /api/download` 请求体：

```json
{
  "loader": "fabric",
  "gameVersion": "1.20.1",
  "loaderVersion": "0.15.11",
  "downloadDir": "./downloads",
  "gameDir": "./.minecraft",
  "autoInstall": true,
  "downloadVanilla": true,
  "downloadAssets": true,
  "isolate": true,
  "threads": 32,
  "mirror": "auto"
}
```

SSE 事件类型：`log`（日志）、`progress`（下载进度）、`done`（完成）、`error`（失败）。

## 已知限制

- NeoForge 仅支持 Minecraft 1.20.2 及以上，更早版本会提示无可用版本。
- 安装器安装参数采用官方 CLI：Fabric 使用 `client -dir ... -mcversion ... -loader ...`，Forge / NeoForge 使用 `--installClient`。
- 极老的 Forge 版本（1.12 及以前）安装器 CLI 行为可能不同。

## 许可证

[MIT](./LICENSE)
