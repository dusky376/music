# PureTone · 本地网易云播放器

原生 HTML / CSS / ES Modules 前端 + Node（零依赖）本地代理后端的网页音乐播放器。数据上游支持**本地自托管 NeteaseCloudMusicApi**（默认，`start-server.bat` 自动编排）或公共代理回退；音频由本地后端转流，规避混合内容与 CORS 问题。

## 特性

- **前后端分离**：前端无构建工具、无 npm 依赖；后端用 Node 内置 `http`，端口 `8787`，只绑定 `127.0.0.1`。
- **服务端缓存与预热**：内存 TTL 缓存 + in-flight 去重；启动后先预热首屏板块，再每 4 秒补齐其余板块。切板块在浏览器端是同步渲染（<100ms）。
- **三层缓存**：后端内存 TTL → 前端内存 Map → `localStorage` SWR（6 小时），刷新页面也能秒开。
- **音频代理**：免费歌由 `/api/audio/:id` 流式转发并支持 Range，可正常拖动进度；VIP / 付费歌明确提示"登录后可播放"并自动跳转下一首（连续 3 首失败会停止，避免刷屏）。
- **歌词与评论**：歌词延迟 1.2s 预取（快速切歌不打爆接口），歌词/翻译高亮滚动、点击跳转；评论热评+最新去重合并。
- **状态恢复**：收藏、最近播放、音量/随机设置、上次播放队列与进度全部持久化，刷新后恢复但启动时不预载音频。
- **键盘操作**：`Space` 播放/暂停、`←/→` 快退/进 5s（Shift 30s）、`↑/↓` 音量、`M` 静音、`L` 收藏、`F` 歌词页、`Q` 队列、`N/P` 切歌、`?` 快捷键面板；滑块聚焦时方向键走滑块自身语义。
- **响应式**：桌面三栏，移动端抽屉导航 + 300px 侧栏，390px 宽度无横向溢出。

## 快速开始

双击 **`start-server.bat`**（推荐）：自动启动两个服务——①本地网易云 API（`netease-api\`，端口 3000，NeteaseCloudMusicApi 4.32.0 自托管，替代公共代理 `apis.netstart.cn`，高峰期不再超时）→ ②PureTone 后端（端口 8787，`NETEASE_API=http://127.0.0.1:3000`），健康检查通过后自动开页面。重复双击不会二次启动；`stop-server.bat` 一键停两个服务。

```powershell
cd E:\workspace\music
.\start-server.bat       # 或 npm start；/nobrowser 参数可不弹浏览器
```

还原公共上游：不设 `NETEASE_API` 环境变量直接 `npm start` 即可（`server/config.js` 内置回退）。

- `npm run check`：对全部 JS 做语法检查。
- `npm test`：零依赖测试（缓存/LRC 解析/格式化/音轨标准化），`node tests/run.mjs`。
- 可选环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1）、`NETEASE_COOKIE`（配置后走完整音源接口）、`NETEASE_API`（上游代理地址）、`WARM=0`（关闭预热）。

## 目录结构

```
music/
├─ index.html            # 页面壳
├─ manifest.webmanifest  # PWA 清单
├─ assets/               # 封面兜底图、PWA 图标（pwa.svg）
├─ server/               # Node 后端（零依赖）
│  ├─ index.js           # 路由、静态服务、安全头
│  ├─ netease.js         # 上游适配、缓存编排、音频代理、登录态、预热
│  ├─ cache.js           # 内存 TTL + in-flight 去重 + 前缀失效
│  └─ config.js          # 板块/歌单 ID、TTL、端口
├─ src/                  # 原生前端（ES Modules）
│  ├─ main.js            # 入口装配
│  ├─ core/              # bus / store / player（状态机）/ api / storage
│  └─ ui/                # nav / tracklist / playerbar / lyrics / immersive / queue / search / login / similar...
├─ tests/run.mjs         # 缓存/LRC/格式化/normalizeTrack 单测
├─ netease-api/          # 本地上游 NeteaseCloudMusicApi（端口 3000，高峰超时的解法）
├─ start-server.bat      # 一键启动（3000 + 8787 双进程编排，勿改编码）
├─ stop-server.bat       # 一键停止
├─ docs/ARCH.md          # 架构说明
├─ docs/API.md           # 本地接口文档
├─ miniprogram/          # 微信小程序端（原生，复用同一后端）
└─ 踩坑与复利.md          # 本项目问题与经验记录
```

## 已知边界

- 匿名模式下 VIP / 付费歌曲不可播放；**侧栏底部"扫码登录网易云"**后即可完整播放（凭据只存本机 `server/.login-cookie`），支持音质选择（标准/320k/无损，登录态下按级别自动降级）。
- 歌词/板块冷请求依赖上游速度（0.7–5s），缓存命中后近乎瞬时；上游高峰期可能整体超时（`start-server.bat` 前端会显示"二维码拉取失败"，稍后重试）。
- 仅枚举单曲/歌手/专辑搜索，不支持歌单搜索；歌单管理暂未实现（接口已验证可行，见踩坑日志）。
- PWA 已可"添加到主屏幕"（manifest + 图标 + 主题色）；暂无离线 Service Worker。
- 扫码登录的"确认成功"分支需真实手机扫码验证，逻辑已按 800/801/802/200|803 状态机实现。
