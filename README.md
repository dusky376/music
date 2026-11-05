# PureTone · 本地网易云播放器

原生 HTML / CSS / ES Modules 前端 + Node（零依赖）本地代理后端的网页音乐播放器。数据来自网易云公共代理 `apis.netstart.cn/music`，音频由本地后端转流，规避混合内容与 CORS 问题。

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

```powershell
cd E:\workspace\music
npm start          # 或 node server/index.js
# 打开 http://127.0.0.1:8787
```

- `npm run check`：对全部 JS 做语法检查。
- 可选环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1）、`NETEASE_COOKIE`（配置后走完整音源接口）、`NETEASE_API`（上游代理地址）、`WARM=0`（关闭预热）。

## 目录结构

```
music/
├─ index.html            # 页面壳
├─ assets/               # 封面兜底图等静态资源
├─ server/               # Node 后端（零依赖）
│  ├─ index.js           # 路由、静态服务、安全头
│  ├─ netease.js         # 上游适配、缓存编排、音频代理、预热
│  ├─ cache.js           # 内存 TTL + in-flight 去重
│  └─ config.js          # 板块/歌单 ID、TTL、端口
├─ src/                  # 原生前端（ES Modules）
│  ├─ main.js            # 入口装配
│  ├─ core/              # bus / store / player（状态机）/ api / storage
│  └─ ui/                # nav / tracklist / playerbar / lyrics / immersive / queue / search...
├─ docs/ARCH.md          # 架构说明
├─ docs/API.md           # 本地接口文档
└─ 踩坑与复利.md          # 本项目问题与经验记录
```

## 已知边界

- 匿名模式下 VIP / 付费歌曲不可播放（上游需要登录态）；配置 `NETEASE_COOKIE` 后按无损→标准自动降级。
- 歌词/板块冷请求依赖上游速度（0.7–5s），缓存命中后近乎瞬时。
- 仅枚举单曲/歌手/专辑搜索，不支持歌单搜索；登录、歌单管理暂未实现（接口已验证可行，见踩坑日志）。
