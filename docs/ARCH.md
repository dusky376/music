# 架构说明

## 总览

```
浏览器（原生 ES Modules，无构建）
   │  只请求本地 /api/*（CSP 限定）
   ▼
Node 本地服务 :8787（仅 127.0.0.1）
   │  内存 TTL 缓存 + in-flight 去重 + 启动预热
   ▼
网易云公共代理 https://apis.netstart.cn/music
   │
   └─ 音频流 CDN（由后端流式转发，支持 Range）
```

## 关键决策与理由

1. **前端只连本地 API，不直连上游**
   上游歌词/板块接口 0.7–5s 不等、音频外链 302 到 http CDN（https 页面会被混合内容拦截）。统一走 `/api/*` 后这些脏细节收敛在后端。

2. **匿名模式不请求 `/song/url/v1`**
   公共代理对无 cookie 的取流请求直接回 404，对新歌每首都白等一次 RTT。`getTrackUrl`：`fee ∈ {1,4}` 返回 `{"url":null,"reason":"login_required"}`，否则返回本地 `/api/audio/:id`。

3. **固定歌单 ID 而非"查歌单再查歌曲"**
   分类板块（华语/欧美/摇滚/学习）用固定 playlist ID，去掉一次串行 RTT（冷启动省 ~1.1s）。

4. **三层缓存（SWR）**
   - 后端内存 TTL（板块 10min、分类 6h、歌词 24h 等），同 key 请求做 in-flight 合并；
   - 前端内存 Map 缓存本次会话；
   - `localStorage` 存 6h 快照（`pt_cache_<key>`）。切板块先同步渲染快照，过期再静默刷新。
   实测：浏览器缓存清空后切板块 52–62ms；命中内存 <10ms。

5. **启动预热，低优先级补齐**
   首屏板块先热（保护首播体验），其余板块每 4s 一个逐步补，避免与用户抢带宽。

6. **播放是 `<audio>` 事件驱动的状态机**
   `loading → buffering → playing/paused → error`，歌词滚动、rAF 进度条、mediaSession 元数据都由状态总线（`player:*` 事件）驱动；暂停态 rAF 计数归 0，空闲 CPU ≈0。

7. **错误恢复策略**
   - VIP/付费 → 明确提示 + 标记 unavailable，自动播放时跳下一首；连续 3 首失败停止而非死循环（`sessionStorage` 计数）；
   - 网络/解码失败 → 缓冲 450ms 后重试 1 次；
   - 简版数据兜底：榜单主接口失败时降级到搜索接口重建列表。
   - `loadedUrl` 追踪防止错误态点播放时播放上一首的残留音源；只有真正开始播放才写 resume，避免失败歌污染恢复状态。

8. **歌词懒加载**
   非沉浸页延迟 1.2s 预取（token 取消机制防快速切歌）；沉浸页歌词 tab 才请求；评论切 tab 时才加载。歌词远处行只保留轻模糊（≤0.6px），可读性优先。

## 前端模块

- `core/bus.js` 事件总线；`core/state.js` 全局 store + localStorage 持久化；`core/player.js` 状态机；`core/api.js` 带超时取消的 fetch 客户端。
- `ui/` 各界面只订阅事件、不互相 import 大量状态：`nav`（板块/抽屉/滚动记忆）、`tracklist`（渲染/收藏/键盘）、`playerbar`（进度/音量滑块）、`lyrics`（解析滚动）、`immersive`（歌词+评论页）、`queue`、`search`（防抖/取消/滚动恢复）。

## 后端模块

- `server/index.js`：路由分发、静态白名单（`/src` `/assets`）、CSP 等安全头、Range 音频代理。
- `server/netease.js`：`upstream()` 封装（UA/超时/https 化）、数据规范化（`normalizeTrack`）、评论去重合并、`getTrackUrl` 登录态降级链、`warmSections`。
- `server/cache.js`：TTL map + in-flight `Promise` 复用。
- `server/config.js`：全部可调参数集中于此。

## 测试方式

- `npm run check`：全部 JS 语法检查。
- 手动回归：播放/搜索/切板块/队列/歌词评论/抽屉/快捷键/390px 溢出检查（浏览器 + `browser.*` 工具）。
- Lighthouse：无障碍/最佳实践/SEO 全 1.0。
