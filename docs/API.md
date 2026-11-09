# PureTone 本地 API 文档

> 对应实现版本：2026-11-09 安全加固后。本文即契约，与 `tests/security.mjs` 的黑盒断言一一对应。

## 监听与安全模型

- 默认**只监听 `127.0.0.1:8787`**。设置 `EXPOSE_LAN=1` 才额外绑定探测到的内网 IPv4（供小程序同 WiFi 调试），启动时打印该地址与醒目警告。
- **所有请求**（含静态资源）都要通过三层校验，任一失败返回 `403`：
  1. `Host` 白名单：`localhost` / `127.0.0.1` / `::1`（`EXPOSE_LAN=1` 时加内网 IP）——挡 DNS rebinding；
  2. `Origin` 若存在，必须是 `http://localhost:8787` / `http://127.0.0.1:8787` / `http://[::1]:8787`（`ALLOWED_ORIGINS` 可追加）；
  3. `Sec-Fetch-Site: cross-site` 一律拒绝。
- **敏感接口**额外要求请求头 `X-PureTone-Token: <token>`，token 由 `GET /api/session` 获取（每进程随机）。覆盖：`/api/login/qr`、`/api/login/qr/check`、`/api/logout`、`/api/user`。挡住 `<img>` / `<form>` 之类无需读响应即可触发的简单请求。
- 二维码创建每 IP 每分钟 5 次、轮询 90 次；`/api/logout` 与 `/api/user` 每 IP 每分钟 12 次。超限返回 `429 RATE_LIMITED`。
- 所有响应（**包括 200/206 音频流**）都带 `X-Content-Type-Options: nosniff`、`Referrer-Policy`、`X-Frame-Options: DENY`、CSP。
- CSP 概要：`default-src 'self'; img-src 'self' https: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`。

错误响应统一为 JSON，内部异常不回显原始错误串：

```json
{ "error": { "code": "BAD_LEVEL", "message": "音质参数不合法" } }
```

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `BAD_HOST` / `BAD_ORIGIN` / `CROSS_SITE` | 403 | 来源校验失败 |
| `CSRF_REJECTED` | 403 | 敏感接口缺/错 token |
| `RATE_LIMITED` | 429 | 触发限流 |
| `BAD_PARAM` | 400 | 参数编码/格式非法（含畸形 URI） |
| `BAD_LEVEL` / `BAD_FEE` / `BAD_LIMIT` / `BAD_ID` / `BAD_KEY` | 400 | 参数值非法 |
| `FORBIDDEN` | 403 | 静态路径越出根目录 |
| `NOT_FOUND` | 404 | 路径或接口不存在 |
| `UNSAFE_AUDIO_URL` / `AUDIO_*` | 502/504 | 音源地址被白名单拒绝或连接失败 |
| `UPSTREAM_*` | 502/504 | 上游接口异常 |

## GET /api/session

取会话令牌，无需 token。前端/小程序启动时调用一次并缓存。

```json
{ "token": "…48 hex…", "exposeLan": false, "lanUrl": null }
```

## GET /api/health

```json
{
  "ok": true,
  "upstream": "http://127.0.0.1:3000",
  "envCookie": false,
  "login": { "logged": false, "source": "none" },
  "cache": { "size": 12, "hits": 0, "misses": 0, "inflight": 0 },
  "uptime": 320,
  "exposeLan": false
}
```

- `envCookie` **只表示是否配置了 `NETEASE_COOKIE` 环境变量**，不代表真实登录态；排障请看 `login.logged` + `upstream`（旧版那个语义相反的 `cookie` 字段已移除）。
- `login.source`：`env` / `qr` / `none` / `logged_out`（用户主动退出过，重启不会自动恢复）。
- `upstream` 是 `NETEASE_API`（默认公共代理 `https://apis.netstart.cn/music`；`start-server.bat` 显式传本地 `http://127.0.0.1:3000`）。两者不一致往往意味着端口被另一个「静默回退」的进程占了。

推荐本地自托管上游：

```powershell
cd music\netease-api
npm install --registry https://registry.npmmirror.com
node node_modules\NeteaseCloudMusicApi\app.js   # 127.0.0.1:3000
```

## 扫码登录

凭据只存**本机**：内存 + `server/.login-cookie`（`mode: 0o600`，已加入 `.gitignore`）。凭据通过 `Cookie` **请求头**传给上游，不再拼进 URL query（老版本上游可用 `NETEASE_COOKIE_QUERY=1` 回退）。

| 接口 | 方法 | token | 说明 |
| --- | --- | --- | --- |
| `/api/login/status` | GET | — | `{ "logged": false, "source": "none" }` |
| `/api/login/qr` | GET | 必需 | `{ "key": "<unikey>", "qrimg": "data:image/png;base64,…" }` |
| `/api/login/qr/check?key=` | GET | 必需 | 轮询状态；`key` 必须是本进程创建过的 |
| `/api/logout` | POST | 必需 | 见下 |
| `/api/user` | GET | 必需 | `{ logged, profile }` 或 `{ logged:false, profile:null, reason:"credential_invalid" }` |

- 上游缺 `unikey` 或缺 `qrimg` 时直接返回 `502 LOGIN_QR`，**不会**拿 `code: 200` 当 key 生成空白二维码。
- `check` 状态机（前端 2 秒轮询）：`801 → waiting`、`802 → scanned`、`800 → expired`、`200|803 → { status:"success", nickname }`。
- `POST /api/logout` 返回 `{ ok, cloud, warnings }`：清理本机凭据、写入 `server/.logged-out` 防重启复活、**通知上游 `/logout` 让云端 cookie 失效**；磁盘删除失败或云端通知失败会出现在 `warnings`，不再静默吞掉。
- 上游 `-462/301` 风控**不再删除用户凭据**，改为返回 `reason: "risk_control"`。

## GET /api/sections

全部板块元信息。以服务端 `SECTIONS` 为准，含「新歌榜」`top_3779629` 与「专注氛围」`cat_学习`。

## GET /api/section/:key

板块曲目列表。`key` 支持 `top_19723756` / `top_3778678` / `top_3779629` / `cat_华语` / `cat_欧美` / `cat_摇滚` / `cat_学习`，以及登录态的 `daily` / `likes`（未登录返回 `401 LOGIN_REQUIRED`）。

```json
{
  "key": "top_19723756", "type": "top", "title": "飙升榜", "subtitle": "…",
  "playlistId": "19723756", "playlistName": "飙升榜", "updatedAt": 1730000000000,
  "tracks": [
    { "id": "3453304463", "name": "降温", "artist": "Zzh", "album": "…", "duration": 199,
      "cover": "https://…300y300", "fee": 0, "vip": false, "paid": false, "mv": 0 }
  ]
}
```

`vip` 来自 `fee === 1`，`paid` 为 `fee === 4`，均由服务端 `normalizeTrack` 统一。

## GET /api/search?q=关键词&limit=60

只支持**单曲搜索**（上游 `type: 1`），关键词可含歌手名/歌名，`limit` 1–100。`q` 由 `URLSearchParams` 解码一次，不做二次解码（含 `%` 的关键词不会被破坏）。返回 `{ keyword, tracks: Track[] }`。

## GET /api/track/:id/url?fee=0&level=standard

取音源。`level` 必须是 `standard | higher | exhigh | lossless` 之一，`fee` 必须是 0–16 整数，否则 `400`。

成功时 `url` **一律是同源代理地址**（登录态与匿名态一致，不再把 CDN 直链交给客户端）：

```json
{
  "url": "/api/audio/3453304463?level=exhigh", "level": "exhigh",
  "br": 320000, "size": 9600000, "trial": false,
  "expireAt": 1730003600000, "reason": null
}
```

失败时 `url: null` + `reason`：

| reason | 含义 | 前端提示 |
| --- | --- | --- |
| `login_required` | VIP / 付费，需登录 | 「登录后可播放」 |
| `no_copyright` | 确无音源 / 需要 VIP 试听 | 「该歌曲暂无版权或音源」 |
| `risk_control` | 上游风控（凭据仍保留） | 「稍后重试或重新扫码」 |
| `upstream_error` | 上游超时/非 JSON/HTTP 错误 | 「音乐服务暂时不可用」 |
| `network` | 取流超时 | 「获取播放地址超时」 |

> `fee` 仅用于 UI 提前提示，**不是安全边界**；真正的权限由音源接口决定。

## GET /api/track/:id/lyric

返回 `{ lrc, tlyric, yrc, klyric }`（原始文本，前端自行解析）。缓存 24h。

## GET /api/track/:id/comments?limit=20

评论 1–50 条（默认 20），热评与最新评论去重合并。实际返回结构：

```json
{
  "total": 1234,
  "comments": [
    { "id": "123456", "content": "…", "liked": 75, "time": 1730000000000,
      "timeStr": "2025-10-01", "user": { "nickname": "…", "avatar": "https://…" } }
  ]
}
```

注意字段是 `liked` / `timeStr` / `user:{nickname,avatar}`，**不是** `likes` / `hot` / 扁平 `user`。

## GET /api/track/:id/similar

相似歌曲，`{ tracks: Track[] }`。

## GET/HEAD /api/audio/:id?level=standard

音频流代理，登录态与匿名态都走这条链路：

- 解析真实音源时，**每一跳 302 都校验**：只接受 `https:` + 音频 CDN 域名白名单（`music.163.com` / `music.126.net` / `126.net` / `163.com` / `netease.com`），拒绝 IP 字面量、回环、私网、云元数据地址；`AUDIO_HOSTS` 可追加白名单。
- `Content-Type` 必须是 `audio/*`（或 `application/octet-stream`）；`text/html; audio=1` 这类伪造标签不再放行。
- `Range` 只允许 `bytes=N-M` 形式，非法返回 `416` + `Content-Range`；上游 `416` 原样透传 `416`。
- **超时只覆盖连接与响应头**（12s），拿到响应头即清除定时器，长音频流不会被中途切断。客户端断开（切歌/关页面）会 abort 上游连接。
- 响应带完整安全头、`Accept-Ranges: bytes`、`Cache-Control: no-store`，用 `node:stream pipeline` 流式转发，不整段缓存。

## 静态资源

- 白名单：`/`、`/index.html`、`/manifest.webmanifest`、`/src/**`、`/assets/**`，仅 GET/HEAD，带 `Cache-Control: no-cache`。
- 额外限制扩展名必须在 MIME 白名单内；`server/` 下的源码、`.login-cookie`、`.logged-out` 一律 404，不会外发。
- 其余路径返回 404 JSON；解析后越出项目根目录返回 403 `FORBIDDEN`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `EXPOSE_LAN` | `0` | 设为 `1` 才额外监听内网 IP |
| `NETEASE_API` | 公共代理 | 上游地址 |
| `NETEASE_COOKIE` | 空 | 初始登录凭据 |
| `NETEASE_COOKIE_QUERY` | `0` | 老版上游不认 Cookie 头时设 `1`（凭据会进 URL，谨慎） |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的额外允许 Origin |
| `AUDIO_HOSTS` | 内置白名单 | 逗号分隔追加音频 CDN 域名 |
| `PURETONE_STATE_DIR` | `server/` | 凭据文件目录；**测试必须用临时目录隔离** |
| `WARM` | `1` | 设 `0` 关闭启动预热 |
