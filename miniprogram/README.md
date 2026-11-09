# PureTone 小程序客户端

与网页版共用同一套本地后端（`server/`，默认 `http://127.0.0.1:8787/api/*`）。原生 WXML/WXSS/JS，零 npm 依赖。

> **产品定位：个人本机自用 / 开源学习作品，当前不具备上线条件。**
> 小程序收缩为「同一 WiFi 下的本机遥控器」：后端默认只监听 `127.0.0.1`，
> 只有显式设置 `EXPOSE_LAN=1` 才额外监听内网 IP 并在启动时打印该地址。
> 本目录不假设已有备案域名或官方音乐授权；配置化、合规说明与平台适配均已做实，
> 但**不能上线、不能分发给普通用户**。上线阻断项见第六节。

## 一、导入方式（唯一推荐）

**用微信开发者工具「导入项目」选择根目录 `E:\workspace\music`，不要选 `miniprogram` 目录。**

- 根 `project.config.json` 才是生效配置：含真 AppID 与 `"miniprogramRoot": "miniprogram/"`，
  微信会把 `miniprogram/` 当作小程序代码根。
- `miniprogram/project.config.json` 仅为历史兼容保留（早期版本曾要求「目录选 miniprogram」），
  其 AppID 已统一为与根配置一致；**单独导入 `miniprogram/` 会让 AppID / 配置来源混淆，不推荐**。
- 根 `project.private.config.json` 是本机个人设置，不纳入版本约定，请勿改动。

## 二、后端地址 BASE_URL（配置化）

地址唯一来源：`miniprogram/config.js` 的 `BASE_URL`。`utils/api.js` 与 `app.js` 的音频 src 都从它取，
不再在任何文件写死内网 IP。

- 启动后端：在项目根目录执行 `npm start`（需 Node >= 18），并设置环境变量 `EXPOSE_LAN=1`；
  后端默认只绑 `127.0.0.1`，只有该开关打开才监听内网 IP。
- 开发 / 真机：把 `config.js` 的 `DEFAULT_BASE_URL` 改成**电脑内网 IP + 端口**（如 `http://192.168.4.12:8787`），
  手机与电脑连**同一 WiFi**。
- 也可运行时覆盖（改完重启小程序生效）：`wx.setStorageSync('pt_base_url', 'http://192.168.x.x:8787')`，
  或在开发者工具「Storage」面板手动加 `pt_base_url`；删除该键即回落到默认常量。
- 模拟器可用 `http://127.0.0.1:8787`；**真机不能用 127.0.0.1**（那是手机自身）。
- 微信开发者工具「详情 → 本地设置」需勾选 **不校验合法域名**（开发期放行 http + IP + 端口）。
- **正式上线必须换 https + 已备案域名**（微信合法域名不支持 IP / 端口 / 内网地址 / localhost），
  并关闭 `urlCheck:false`、在小程序后台配置 request / downloadFile 合法域名。当前未做，故不能上线。

## 三、会话令牌

- 启动时先 `GET ${BASE_URL}/api/session` 取 `{ token, exposeLan }` 并缓存在内存。
- 之后所有 `wx.request`（`section` / `sections` / `track/url` / `lyric` / `user` 等）统一带
  `X-PureTone-Token: <token>`。按契约，`/api/session` 本身无需 token。
- token 失效返回 403 时会**刷新 token 并重试一次**；仍失败或会话初始化失败会 `wx.showToast` 明确提示，
  不会静默 403。
- 若 `exposeLan === false` 而 BASE 是内网 IP，会提示「后端未开启 EXPOSE_LAN=1，真机可能连不上」。

## 四、`urlCheck: false` 的位置与风险

三处均**保留**（开发期需要），但务必知悉风险：

| 文件 | 说明 |
| --- | --- |
| `project.config.json`（根） | 生效配置，`setting.urlCheck: false` |
| `miniprogram/project.config.json` | 兼容保留，`setting.urlCheck: false` |
| `project.private.config.json`（根） | 本机个人设置，`setting.urlCheck: false` |

`urlCheck:false` **只在开发版 / 开发者工具内生效**。体验版与正式版会强制校验合法域名，
当前 http + 内网 IP + 端口的 BASE 会被直接拦截，表现为「列表加载失败 / 放不出声」，且**不是代码 bug**。
上线 / 体验版验收前必须关闭该项并配置合法域名。

## 五、当前范围（v0.3）

- 板块切换 + 列表（会话内存缓存，SWR 先渲染后刷新）；板块清单运行时以 `/api/sections` 为准，
  接口不可达时回落到与 `server/config.js` 对齐的本地兜底（含「新歌榜」「专注氛围」）。
- 账号板块：每日推荐 / 我喜欢的歌曲（与网页版共用同一服务端登录态；登录在网页版扫码，
  小程序 `onShow` 自动同步头像昵称，不必冷启动）。
- 播放全部 / 点歌播放 / 播放器页（封面、进度 slider、上下首、播放暂停、歌词 LRC 高亮）。
- 播放改走 `GET /api/track/:id/url` 门禁，拿到同源 `/api/audio/:id?level=...` 再播；
  失败按 `reason` 区分 `no_copyright / login_required / risk_control / upstream_error`，
  上游故障不再显示成「无版权」。
- 全局单例音频（`app.js`）：优先 `wx.getBackgroundAudioManager()` 支持后台 / 锁屏 / 线控；
  平台不支持时降级 `wx.createInnerAudioContext()`；监听来电中断 `onAudioInterruptionBegin/End`。
- VIP/付费：toast 提示并自动跳下一首；连续 3 首失败停止并归位状态。

### 事件机制

- `app.js` 提供 `subscribe(name, fn)` / `unsubscribe(name, fn)` 全局订阅表；页面 `onLoad` 订阅、`onUnload` 退订。
- 兼容保留旧「当前页 onAudioXxx」兜底推送。
- 播放器 slider 的 `bindchanging` 拖动锁 + 触摸即锁 + 100ms 自愈提交（用户已有修复，保持不变）。

### 已知限制

- **队列不支持顺序调整**：`player.wxml` 的队列行**没有任何拖拽把手**（既无六点把手符号，也无可拖动的视觉暗示），
  只能点选切歌。审计报告第 18 条称小程序队列有六点拖拽把手，与当前工作区代码不符（把手只存在于 Web 端
  `src/ui/queue.js`）。为避免「看起来能拖却拖不动」，这里不引入把手、也不引入无法真机验证的排序逻辑。
- 总时长用列表 `track.duration` 兜底：`/api/audio` 是流式转发、无 Content-Length，`audio.duration` 可能为 0；
  `onTimeUpdate` 拿到有效时长后再覆盖。
- 无搜索页、无小程序内扫码登录 / 退出、无评论 / 收藏 / 历史 / 音质 / 音量 / 离线缓存 / 暗色模式。
  登录仍需在网页版完成。

## 六、上线阻断清单（当前均未解决，勿写「已支持上线」）

1. **https + 已备案域名**：BASE 目前是 http + 内网 IP + 端口，微信合法域名不支持；
   需备案域名、TLS 证书，并在小程序后台配置 request / downloadFile 合法域名，关闭 `urlCheck:false`。
2. **音乐 / 音频类目版权授权或资质**：第三方抓取网易云音源是小程序提审常见驳回理由；
   当前无版权授权 / 网络文化经营等相关资质。
3. **用户隐私保护指引与 `wx.requirePrivacyAuthorize`**：需在小程序后台配置《用户隐私保护指引》，
   在采集用户信息前调用 `wx.requirePrivacyAuthorize`；当前未接入。
4. **服务端多用户鉴权隔离**：当前后端是**单例登录态**，所有人共用同一个网易云账号听 VIP、看收藏，
   无用户体系、无数据隔离；既不是产品规划里的「用户自有账号」，也存在账号被封风险。
5. **体验版开合法域名校验的完整真机验收**：见第七节，未通过前不能提审 / 发布。

以上任意一项不解决，都不具备上线条件。

## 七、真机验收清单（体验版，务必打开合法域名校验）

- [ ] 冷启动：`/api/session` 成功取到 token，所有接口带 `X-PureTone-Token`，无静默 403。
- [ ] 榜单：7 个板块（含「新歌榜」「专注氛围」）标题与服务端一致；切板块不错乱。
- [ ] 播放 3 分钟不中断：确认后端未再出现 20s 断流，`/api/audio` 全程可播。
- [ ] 进度拖动：`max` 非 0，拖动不回跳、松手即 seek；歌词跟随与点行跳播。
- [ ] 切后台 / 锁屏：`wx.getBackgroundAudioManager` 是否正常续播、锁屏信息与线控是否出现（**必测，
      内网 http 音源在后台可能被系统拦截**）。
- [ ] 来电中断：来电暂停、挂断后恢复播放，状态与 UI 一致。
- [ ] 错误分类：断网 / 超时 / 403 / 404 / `upstream_error` / `risk_control` 各有可理解提示且不误报「无版权」。
- [ ] 网页版扫码登录后切回小程序：`onShow` 自动刷新头像昵称与账号板块，无需冷启动。
- [ ] 连续失败 3 首：状态归位 idle，页面不再显示「正在播放」。
- [ ] 换 BASE / 换 AppID / 关闭 `urlCheck:false` 后，用**体验版**重跑以上全部（开发版结果不能代表体验版）。
