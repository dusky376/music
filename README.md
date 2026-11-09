# PureTone · 本地网易云播放器

原生 HTML / CSS / ES Modules 前端 + Node（零依赖）本地代理后端的网页音乐播放器。数据上游支持**本地自托管 NeteaseCloudMusicApi**（`start-server.bat` 默认编排）或公共代理回退；音频由本地后端转流，规避混合内容与 CORS 问题。

> **定位：个人本机自用 / 开源学习作品，不是面向公众的产品。** 本项目不提供音乐内容、不绕过任何付费机制，也不附带版权授权。请遵守所用音乐平台的服务条款；VIP / 付费内容需要登录你自己的账号。网站与小程序**当前均不具备上线条件**，详见「已知边界」。

## 特性

- **前后端分离**：前端无构建工具、无 npm 依赖；后端用 Node 内置 `http`，端口 `8787`，**默认只绑定 `127.0.0.1`**。
- **默认收敛的暴露面**：Host 白名单 + Origin / `Sec-Fetch-Site` 校验 + 敏感接口会话令牌 + 二维码限流；局域网访问需显式 `EXPOSE_LAN=1`。
- **服务端缓存与预热**：内存 TTL 缓存 + in-flight 去重；启动后预热首屏板块，再每 4 秒补齐其余板块。
- **三层缓存**：后端内存 TTL → 前端内存 Map → `localStorage` SWR（6 小时），刷新页面也能秒开。
- **统一音频代理**：登录态与匿名态都返回同源 `/api/audio/:id`，不把 CDN 直链交给客户端；逐跳校验 302 目标、支持 Range / 416、超时只覆盖首字节，长音频不会被切断。
- **歌词与评论**：歌词延迟预取，歌词/翻译高亮滚动、点击跳转；评论热评+最新去重合并。
- **状态恢复**：收藏、最近播放、音量/随机设置、上次播放队列与进度全部持久化。
- **键盘与无障碍**：`Space` 播放/暂停、`←/→` 快退/进 5s（Shift 30s）、`↑/↓` 音量、`M` 静音、`L` 收藏、`F` 歌词页、`Q` 队列、`?` 快捷键面板；四个模态弹窗都有焦点陷阱与焦点恢复，列表状态由独立 live region 播报。
- **响应式**：桌面三栏，移动端抽屉导航，safe-area 适配，主控制键 ≥44px 触控热区。

## 快速开始

双击 **`start-server.bat`**（推荐）：自动启动两个服务——① 本地网易云 API（`netease-api\`，端口 3000）→ ② PureTone 后端（端口 8787，`NETEASE_API=http://127.0.0.1:3000`）。脚本会校验 Node ≥18、精确匹配端口（不会误杀 `:87870`、`:30000` 这类进程）、用 `curl -f --max-time` 做健康检查并核对 `upstream` 是否指向预期地址，通过后才打开页面。`stop-server.bat` 温和停止，不强杀。

```powershell
cd E:\workspace\music
.\start-server.bat       # /nobrowser 参数可不弹浏览器
npm start                # 或直接启动后端（不自动拉起上游）
```

还原公共上游：不设 `NETEASE_API` 直接 `npm start`（`server/config.js` 内置回退）。

### 质量门禁

```powershell
npm run check   # scripts/check.mjs：递归语法检查全部 36 个 JS/MJS（排除第三方目录）
npm test        # tests/run.mjs（32 项单测/真身回放）+ tests/security.mjs（33 项安全与 HTTP 黑盒）
```

`tests/security.mjs` 会用独立端口 8791 起子进程，并把凭据状态隔离到临时目录（`PURETONE_STATE_DIR`），**不会触碰你真实的 `server/.login-cookie`**。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `EXPOSE_LAN` | `0` | 设为 `1` 才额外监听内网 IPv4（小程序真机调试用，仅限可信内网） |
| `NETEASE_API` | 公共代理 | 上游地址 |
| `NETEASE_COOKIE` | 空 | 初始登录凭据（也可用侧栏扫码登录） |
| `NETEASE_COOKIE_QUERY` | `0` | 老版上游不认 Cookie 头时设 `1`（凭据会进 URL query，谨慎） |
| `ALLOWED_ORIGINS` / `AUDIO_HOSTS` | 空 | 追加允许 Origin / 音频 CDN 域名 |
| `PURETONE_STATE_DIR` | `server/` | 凭据目录，测试隔离用 |
| `WARM` | `1` | 设 `0` 关闭启动预热 |

## 安全模型（2026-11-09 加固）

- 默认只绑回环；`EXPOSE_LAN=1` 时打印内网地址并警告，该模式下同网段设备可访问**无需登录的读接口**，请勿在公共 WiFi 使用。
- 所有请求校验 `Host`；跨站 `Origin` / `Sec-Fetch-Site: cross-site` 直接拒绝（防 DNS rebinding 与普通跨站页面）。
- 二维码创建/轮询、退出登录、账号资料要求 `X-PureTone-Token`，令牌从 `GET /api/session` 获取（每进程随机）；`<img src>` 之类简单请求无法触发写接口。
- 音源 URL 与每一跳 302 都过 `https:` + CDN 域名白名单，拒绝回环/私网/云元数据地址（SSRF 防护）。
- 凭据 `mode: 0o600` 落盘、用 `Cookie` 请求头传递；风控码不再删除凭据；退出会通知上游并留下防复活标记；删文件失败会明确告警。
- 完整契约见 `docs/API.md`，改动与验证记录见 `docs/FIXES-2026-11-09.md`，原始审查见 `docs/AUDIT-2026-11-09.md`。

## 目录结构

```
music/
├─ index.html            # 页面壳
├─ manifest.webmanifest  # PWA 清单
├─ assets/               # 封面兜底图、PWA 图标
├─ server/
│  ├─ index.js           # 路由、静态白名单、请求守卫、限流、会话
│  ├─ security.js        # 安全头 / Host-Origin 守卫 / 音频 URL 白名单 / 限流
│  ├─ netease.js         # 上游适配、缓存编排、音频代理、登录态、预热
│  ├─ cache.js           # 内存 TTL + in-flight 去重 + 前缀失效
│  └─ config.js          # 板块/歌单 ID、TTL、端口、开关
├─ src/
│  ├─ main.js            # 入口装配
│  ├─ core/              # bus / state（含 playableTracks）/ player / api / storage
│  └─ ui/                # nav / tracklist / playerbar / lyrics / immersive / queue / search / login / dialog ...
├─ tests/
│  ├─ run.mjs            # 单测 + 小程序 app 真身回放
│  └─ security.mjs       # 安全层 + HTTP 黑盒
├─ scripts/              # check.mjs / healthcheck.mjs / start-detached.ps1
├─ netease-api/          # 本地上游（第三方依赖，端口 3000）
├─ miniprogram/          # 微信小程序端（当前为同 WiFi 遥控器，不可上线）
├─ start-server.bat / stop-server.bat / autostart-server.bat
├─ docs/ARCH.md          # 架构说明
├─ docs/API.md           # 本地接口契约
└─ 踩坑与复利.md          # 问题与经验记录
```

## 已知边界

- **合规**：`产品规划.docx` 选择的路径是「用户扫码登录自己的账号，播放器只作为官方客户端的替代前端」。本项目不含官方授权、不含备案域名，小程序音乐类目所需资质与隐私指引均未具备；**请勿公开部署或提审**。
- **小程序**：`miniprogram/README.md` 列明了上线阻断清单。当前只能在「开发版 + 后端 `EXPOSE_LAN=1` + 同 WiFi + BASE 填对内网 IP + 开发者工具勾选不校验合法域名」下作为遥控器使用；后台播放/锁屏/线控等改造**尚未经过真机验证**。
- **交付形态**：启动脚本 + 两个常驻 Node 进程，不是可分发的桌面应用；产品规划里的 Tauri 桌面端、双源切换与歌单导入均未实现。
- 匿名模式下 VIP / 付费歌曲不可播放；扫码登录后按音质逐级降级（标准/320k/无损）。
- 搜索**只支持单曲**（上游 `type: 1`），关键词可匹配歌名/歌手名；不支持歌单搜索、歌单管理。
- PWA 可「添加到主屏幕」，暂无离线 Service Worker。
- 音频、榜单等业务链路依赖第三方上游可用性与你自己的账号权限，本项目不保证可用性。
