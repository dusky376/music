# 架构说明

> 对应实现版本：2026-11-09 安全加固后。接口契约见 `docs/API.md`，改动记录见 `docs/FIXES-2026-11-09.md`。

## 总览

```
浏览器（原生 ES Modules，无构建）
   │  只请求本地 /api/*（CSP connect-src 'self'）
   │  启动时先取 /api/session，之后 JSON 请求带 X-PureTone-Token
   ▼
请求守卫（Host 白名单 / Origin / Sec-Fetch-Site / 敏感接口 token / 限流）
   ▼
Node 本地服务 :8787（默认仅 127.0.0.1；EXPOSE_LAN=1 才加内网 IP）
   │  内存 TTL 缓存 + in-flight 去重 + 启动预热
   ▼
上游 NeteaseCloudMusicApi
   │  默认 start-server.bat 编排的 http://127.0.0.1:3000
   │  未设置 NETEASE_API 时回退公共代理 https://apis.netstart.cn/music
   │  凭据走 Cookie 请求头，不进 URL query
   ▼
音频 CDN（服务端逐跳校验 302 + 域名白名单，流式转发，支持 Range）
```

小程序端是**同一后端的第二客户端**：`miniprogram/config.js` 单一来源配置 BASE，`utils/api.js` 统一注入会话令牌，音频改走 `getBackgroundAudioManager()` 以支持后台/锁屏。两端数据仍各自本地存储，未做账号体系与云端同步。

## 关键决策与理由

1. **前端只连本地 API，不直连上游**
   上游歌词/板块接口 0.7–5s 不等、音频外链 302 到 http CDN（https 页面会被混合内容拦截）。统一走 `/api/*` 后这些脏细节收敛在后端。**登录态下也只返回同源 `/api/audio/:id?level=…`**，不再把 CDN 直链交给 `<audio>`，两条语义不同的播放链路合并成一条。

2. **匿名模式不请求 `/song/url/v1`**
   公共代理对无 cookie 的取流请求直接回 404。`getTrackUrl` 对 `fee ∈ {1,4}` 提前返回 `reason: "login_required"`（仅 UI 提示，不是安全边界），其余返回本地代理地址；实际能否播放由音源接口决定。

3. **安全边界放在服务端，而不是靠「只绑回环」**
   绑定地址不等于鉴权：DNS rebinding、同网段设备、本机其它进程都能构造任意 Header。`server/security.js` 集中实现 Host 白名单、Origin/Fetch-Site 校验、会话令牌、二维码限流、音频 URL 白名单与逐跳 302 校验。`EXPOSE_LAN=1` 是显式开关而不是默认行为。

4. **凭据与风控解耦**
   `.login-cookie` 以 `0o600` 落盘、用请求头传递；上游 `-462/301` 多为临时风控，**不再因此删除用户凭据**。退出登录会清本机 + 通知上游 `/logout` + 写 `.logged-out` 防止 env 凭据重启复活；磁盘/云端失败以 `warnings` 明确返回。

5. **音频超时只覆盖首字节**
   `fetchGuardedAudio()` 的定时器在拿到响应头后清除，长音频流不会再被 20 秒硬超时切断；客户端断开时主动 abort 上游。`Range` 做格式校验，非法返回 416，上游 416 原样透传。

6. **固定歌单 ID 而非「查歌单再查歌曲」**
   分类板块用固定 playlist ID，去掉一次串行 RTT。

7. **三层缓存（SWR）**
   后端内存 TTL（板块 10min、分类 6h、歌词 24h 等）+ in-flight 合并；前端内存 Map；`localStorage` 6h 快照。切板块先同步渲染快照，过期再静默刷新；登录态变化会按前缀失效音频/板块缓存。

8. **播放是 `<audio>` 事件驱动的状态机**
   `loading → buffering → playing/paused → error`；歌词滚动、进度、mediaSession 元数据都由事件总线驱动。音质/进度/音量等 UI 全在 `src/ui/`，状态与持久化在 `src/core/`。

9. **错误分类**
   `no_copyright` / `login_required` / `vip_required` / `risk_control` / `upstream_error` / `network` 分开返回，上游故障不再伪装成「无版权」；连续 3 首失败停止而非死循环。

10. **可访问性与动效的统一层**
    `src/ui/dialog.js` 统一四个模态的焦点移入/恢复、Tab 循环、底层 `inert`；整张歌曲表移出 live region，改由独立 `role="status"` 播报简短摘要；进度用 `transform: scaleX()`，Play↔Pause 用双 SVG + CSS morph；`prefers-reduced-motion` 在 CSS 与 JS 双端照顾。

11. **筛选规则单一来源**
    `core/state.js` 的 `playableTracks()` 是「只看可播放」的唯一实现，导航渲染、「播放全部」、空态起播都调它，避免筛掉 VIP 却仍把它加入队列。用户手动点过筛选后写入 `filterManuallySet`，默认策略不再覆盖用户选择。

## 前端模块

- `core/bus.js` 事件总线；`core/state.js` 全局 store + 持久化 + `playableTracks`；`core/player.js` 状态机；`core/api.js` 带超时取消与会话令牌的 fetch 客户端。
- `ui/` 各界面只订阅事件：`nav`（板块/抽屉/滚动记忆/筛选）、`tracklist`（渲染/收藏/状态摘要）、`playerbar`（进度/音量/morph）、`lyrics`、`immersive`（歌词+评论+相似）、`queue`、`search`、`login`、`shortcuts`、`dialog`（模态基座）。

## 后端模块

- `server/index.js`：请求守卫接线、路由分发、静态白名单与 MIME 限制、限流、二维码会话登记、优雅退出。
- `server/security.js`：安全头、Host/Origin 守卫、会话令牌、音频 URL 白名单、逐跳 302 的 `fetchGuardedAudio()`、限流器。
- `server/netease.js`：`upstream()` 封装、`normalizeTrack`、评论去重、`fetchDirectUrl` 取流解析（含登录态降级链）、`proxyAudio` 流式转发、登录态与预热。
- `server/cache.js`：TTL map + in-flight Promise 复用。
- `server/config.js`：全部可调参数与开关集中于此。
- `PURETONE_STATE_DIR` 把凭据文件目录参数化，测试子进程用临时目录隔离，避免黑盒断言误删真实登录态。

## 测试与验证

- `npm run check`：`scripts/check.mjs` 递归语法检查全部 36 个 JS/MJS（排除 `netease-api/`、`node_modules/`、`.git/`、`.workbuddy/`）。
- `npm test`：
  - `tests/run.mjs` 32 项——缓存 / LRC / 格式化 / `normalizeTrack`，以及小程序 `app.js` **真身回放**（含后台音频、切歌竞态、时长兜底、VIP 扫描、连续失败状态归位）。
  - `tests/security.mjs` 33 项——`security.js` 纯函数 + 独立端口 8791 的 HTTP 黑盒（Host/Origin/CSRF、参数校验、畸形 URI、静态白名单、路径穿越、安全头、限流）。
- 额外的手动/脚本验证：25 秒持续音频流实测（确认无 20s 中断、Range 416、音频响应带安全头）、DOM id / ESM 导入导出 / JSON 静态一致性核对。
- 仍需**人工真机/浏览器**确认：播放 morph 与封面溶解观感、焦点陷阱与读屏播报、390px 全面屏 dock 裁切、小程序后台播放与来电中断、PWA 主题色。
