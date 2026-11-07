# PureTone 小程序客户端

与网页版共用同一套本地后端（`E:\workspace\music\server`，`http://127.0.0.1:8787/api/*`），保持前后端分离：**一套后端，网页 / 小程序两个客户端并行**。原生 WXML/WXSS/JS，零 npm 依赖。

## 使用步骤

1. 启动后端：
   ```powershell
   cd E:\workspace\music
   npm start
   ```
2. 用微信开发者工具「导入项目」，目录选择 `E:\workspace\music\miniprogram`（appid 先用测试号 `touristappid`）。
3. DevTools 内「详情 → 本地设置」勾选 **不校验合法域名**（开发期放行 `http://127.0.0.1`）。
4. 上线前改动：
   - `utils/api.js` 的 `BASE` 换成已备案 https 域名；
   - 后端部署到服务器（代码与本地一致，替换 `UPSTREAM` 与 cookie 环境变量即可）。

## 当前范围（v0.2）

- 板块切换 + 列表（会话内存缓存，SWR 先渲染后刷新）
- **账号板块**：每日推荐 / 我喜欢的歌曲（与网页版共用同一服务端登录态；登录在网页版扫码，小程序自动同步头像昵称）
- 播放全部 / 点歌播放 / 播放器页（封面、进度 slider、上下首、播放暂停）
- 全局单例音频（`app.js`），跳页不中断播放；`requiredBackgroundModes: audio` 已开启
- 歌词 LRC 解析 + 当前行高亮
- VIP/付费：弹 toast 提示并自动跳下一首（与网页版策略一致）

## 事件机制（v0.2）

- `app.js` 提供 `subscribe(name, fn)` / `unsubscribe(name, fn)` 全局订阅表；页面在 `onLoad` 订阅、`onUnload` 退订，多页面并存皆可收事件。
- 兼容保留旧"当前页 onAudioXxx"兜底推送（未订阅的旧页面不受影响）。
- 播放器 slider 增加 `bindchanging` 拖动锁：拖动中 `time` 事件不覆盖进度，松手（`bindchange`）后才 seek。

## 已知限制

- 真机调试须让手机与电脑同网段，`BASE` 改成电脑内网 IP；
- 后台播放需要 `requiredBackgroundModes: ["audio"]`（验证后端连通后加）；
- `onShow` 后未重置 slider 中点拖动中的状态，快速拖动小概率回跳（已修复：`bindchanging` 拖动锁 + `onShow` 重置 scrubbing）。
