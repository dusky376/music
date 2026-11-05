# PureTone 本地 API 文档

后端只监听 `127.0.0.1:8787`，所有响应带 CSP 等安全头。除音频代理外均为 JSON，错误统一为：

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "上游超时" } }
```

## GET /api/health

健康检查。返回：

```json
{ "ok": true, "upstream": "https://apis.netstart.cn/music", "cookie": false, "cache": { "entries": 12, "inflight": 0 }, "uptime": 320 }
```

## GET /api/sections

全部板块元信息（key、标题、副标题、歌单 ID）。

## GET /api/section/:key

板块曲目列表。`key` 支持内置版块（`top_19723756` 飙升榜、`top_3778678` 热歌榜、`top_3779629` 飙升榜变体）与分类（`cat_华语` / `cat_欧美` / `cat_摇滚` / `cat_学习`）。

```json
{ "key": "top_19723756", "title": "飙升榜", "subtitle": "…", "tracks": [ { "id": "3453304463", "name": "降温", "artist": "Zzh", "album": "…", "duration": 199, "cover": "https://…300y300", "fee": 0, "vip": false, "paid": false, "mv": 0 } ] }
```

`id` / `name` / `artist` / `album` / `duration` / `cover`(https, 300y300) / `fee` / `vip` / `paid` / `mv`。`vip` 来自 `fee ∈ {1,4,8}`，`paid` 为 `fee === 16`，均在服务端 `normalizeTrack` 统一。

## GET /api/search?q=关键词&limit=60

搜索歌曲（1–100 首，默认 60）。返回 `{ keyword, tracks: Track[] }`，缓存 5 分钟。

## GET /api/track/:id/url?fee=0&level=standard

取音源。匿名模式：

- `fee ∈ {1,4}`（VIP/付费）→ `{ "url": null, "reason": "login_required" }`
- 其它 → `{ "url": "/api/audio/:id" }`（相对路径，`<audio>` 直接可用）

配置 `NETEASE_COOKIE` 后走 `/song/url/v1`，按 `level` 逐级降级（lossless→exhigh→higher→standard），风控码 `-462/301` 时返回 `{"url":null,"reason":"vip_required|risk_control"}`。

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

- `/`、`/src/**`、`/assets/**` 允许 GET/HEAD，带 `Cache-Control: no-cache`；
- 其余路径 404 JSON；路径穿越返回 403。
- CSP（概要）：`default-src 'self'; img-src 'self' https: data:; media-src 'self' https: http:; style-src 'self' 'unsafe-inline' …`，封面/头像走 https。
