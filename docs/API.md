# PureTone 本地 API 文档

后端只监听 `127.0.0.1:8787`，所有响应带 CSP 等安全头。除音频代理外均为 JSON，错误统一为：

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "上游超时" } }
```

启动方式：双击 `music/start-server.bat`（一键启动 + 自动打开页面），或 `npm start`。停止用 `stop-server.bat`。

## GET /api/health

健康检查。返回：

```json
{ "ok": true, "upstream": "http://127.0.0.1:3000", "cookie": false, "login": { "logged": false, "source": "none" }, "cache": { "size": 12, "hits": 0, "misses": 0, "inflight": 0 }, "uptime": 320 }
```

`upstream` 是 `NETEASE_API` 环境变量（默认公共代理 `https://apis.netstart.cn/music`）。推荐本地自托管：

```powershell
cd music\netease-api
npm install --registry https://registry.npmmirror.com   # 安装 NeteaseCloudMusicApi@4.32.0
node node_modules\NeteaseCloudMusicApi\app.js           # 监听 127.0.0.1:3000（HOST=127.0.0.1）
# 之后 NETEASE_API=http://127.0.0.1:3000 启动 8787 后端；start-server.bat 已自动编排
```

`login.logged` 为 true 时，VIP/付费曲目可走完整音源；`source`：`env`（NETEASE_COOKIE）/ `qr`（扫码）/ `none`。

## 扫码登录

凭据只存**本机**：内存 + `server/.login-cookie`（已加入 .gitignore），不落数据库。登录/登出会整体清空音频缓存（`delPrefix('audio:')`）。

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/login/status` | GET | `{ "logged": false, "source": "none" }` |
| `/api/login/qr` | GET | 生成二维码 `{ "key": "<uuid>", "qrimg": "data:image/png;base64,…" }` |
| `/api/login/qr/check?key=` | GET | 轮询状态，见下 |
| `/api/logout` | POST | `{ "ok": true }`，清除本机凭据 |

`check` 的状态机（8 秒一轮、前端 2 秒轮询一次）：

- `801` → `{ "status": "waiting" }` 等待扫码
- `802` → `{ "status": "scanned" }` 已扫码，请在手机上确认
- `800` → `{ "status": "expired" }` 二维码过期（前端露出刷新按钮）
- `200` / `803` → `{ "status": "success", "nickname": "…" }` 成功；服务端从 cookie 提取 `MUSIC_U` 并 `/user/account` 拉昵称

设置 `NETEASE_COOKIE` 环境变量优先于扫码（`source: "env"`），扫码态只在其缺失时生效。

## GET /api/sections

全部板块元信息（key、标题、副标题、歌单 ID）。

## GET /api/section/:key

板块曲目列表。`key` 支持内置版块（`top_19723756` 飙升榜、`top_3778678` 热歌榜、`top_3779629` 飙升榜变体）与分类（`cat_华语` / `cat_欧美` / `cat_摇滚` / `cat_学习`）。

```json
{ "key": "top_19723756", "title": "飙升榜", "subtitle": "…", "tracks": [ { "id": "3453304463", "name": "降温", "artist": "Zzh", "album": "…", "duration": 199, "cover": "https://…300y300", "fee": 0, "vip": false, "paid": false, "mv": 0 } ] }
```

`id` / `name` / `artist` / `album` / `duration` / `cover`(https, 300y300) / `fee` / `vip` / `paid` / `mv`。`vip` 来自 `fee === 1`，`paid` 为 `fee === 4`，均在服务端 `normalizeTrack` 统一。

## GET /api/search?q=关键词&limit=60

搜索歌曲（1–100 首，默认 60）。返回 `{ keyword, tracks: Track[] }`，缓存 5 分钟。

## GET /api/track/:id/url?fee=0&level=standard

取音源。匿名模式：

- `fee ∈ {1,4}`（VIP/付费）→ `{ "url": null, "reason": "login_required" }`
- 其它 → `{ "url": "/api/audio/:id" }`（相对路径，`<audio>` 直接可用）

登录态（env 或扫码）下走 `/song/url/v1`，按 `level` 逐级降级（lossless→exhigh→higher→standard），风控码 `-462/301` 时清空登录态并返回 `{"url":null,"reason":"risk_control"}`（HTTP 401），前端提示重新扫码。

## GET /api/track/:id/lyric

歌词。返回 `{ lrc, tlyric, yrc, klyric }`（原始文本，前端自行解析）。缓存 24h。

## GET /api/track/:id/comments?limit=20

评论 1–50 条（默认 20）。热评与最新评论**已去重合并**。返回：

```json
{ "total": 1234, "comments": [ { "id": "A_0001", "user": "…", "avatar": "https://…", "content": "…", "likes": 75, "time": 1730000000000, "hot": true } ] }
```

## GET /api/track/:id/similar

相似歌曲，`{ tracks: Track[] }`。

## GET/HEAD /api/audio/:id

音频流代理。特性：

- 先向上游要免费外链，跟随 302 拿真实 CDN 段；
- `Content-Type` 必须是 `audio/*`，否则判为无版权（VIP 外链会 302 到 HTML 404）；
- 透传 `Range`，返回 `206/416`，进度拖动可用；
- 流式转发（`node:stream pipeline`），不整段缓存。

## 静态资源

- `/`、`/src/**`、`/assets/**`、`/manifest.webmanifest` 允许 GET/HEAD，带 `Cache-Control: no-cache`；
- 其余路径 404 JSON；路径穿越返回 403。
- CSP（概要）：`default-src 'self'; img-src 'self' https: data:; media-src 'self' https: http:; style-src 'self' 'unsafe-inline' …`，封面/头像走 https。
