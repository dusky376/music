// PureTone 小程序入口：唯一的音频实例常驻 app，跨页面共享。
// 后端地址统一来自 config.js（单一来源），不在本文件写死 IP。
// 当前定位：个人本机自用 / 开源学习作品，尚不具备上线条件，详见 README。
const { BASE_URL } = require('./config.js');
const { api, absoluteUrl, ensureSession, getSessionInfo } = require('./utils/api.js');

App({
  _listeners: {},

  globalData: {
    queue: [],       // 当前队列（Track[]）
    index: -1,       // 当前曲目下标
    status: 'idle',  // idle | playing | paused | error
  },

  audio: null,
  failStreak: 0,
  playMode: 'order', // order 顺序 | shuffle 随机
  _useBg: false,     // 是否用 getBackgroundAudioManager
  _bgBound: false,   // 后台音频单例事件是否已绑定（避免重复 onTimeUpdate）
  _playTicket: 0,    // 切歌竞态令牌：异步取链返回前又点歌则丢弃过期结果

  /**
   * 唯一的 onLaunch：先恢复设置 → 再初始化播放器 → 最后预热会话。
   * （旧版有两个同名 onLaunch，后者覆盖前者，playMode 记忆永不执行）
   */
  onLaunch() {
    // 1) 先恢复用户设置
    try {
      this.playMode = wx.getStorageSync('playMode') || 'order';
    } catch (error) {
      // 存储不可用时保持默认顺序
    }
    // 2) 再初始化播放器（单例音频 + 状态机事件 + 来电中断监听）
    this.audio = this._createAudio();
    this._bindInterruptions();
    // 3) 最后预热会话令牌；失败明确提示，不静默 403
    ensureSession()
      .then(() => {
        const info = getSessionInfo();
        // 后端未开 EXPOSE_LAN 却配了内网 IP：真机必连不上，提前告知
        if (info && info.exposeLan === false && !/127\.0\.0\.1|localhost/.test(BASE_URL)) {
          wx.showToast({ title: '后端未开启 EXPOSE_LAN=1，真机可能连不上', icon: 'none', duration: 3000 });
        }
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '会话初始化失败，请检查后端', icon: 'none', duration: 3000 });
        this._emit('error', err);
      });
  },

  /** 切换顺序/随机并落地持久化，返回新模式。 */
  cycleMode() {
    this.playMode = this.playMode === 'order' ? 'shuffle' : 'order';
    try {
      wx.setStorageSync('playMode', this.playMode);
    } catch (error) {
      // 存储失败只影响下次记忆，本次模式照常用
    }
    return this.playMode;
  },

  /**
   * 创建 / 复用音频实例，事件只绑定一次。
   * 优先 wx.getBackgroundAudioManager()（支持后台 / 锁屏 / 线控）；
   * 平台不支持时降级 wx.createInnerAudioContext()（切后台即停）。
   * getBackgroundAudioManager 是全局单例，不能重建、不能重复绑事件。
   */
  _createAudio() {
    const useBg = typeof wx.getBackgroundAudioManager === 'function';
    this._useBg = useBg;
    if (useBg) {
      if (!this.audio) this.audio = wx.getBackgroundAudioManager();
      if (!this._bgBound) {
        this._bindAudioEvents(this.audio);
        this._bgBound = true;
      }
      return this.audio;
    }
    // 降级 innerAudioContext：每次换源重建，规避「换 src 继承上一首播放位置」
    if (this.audio) {
      try { this.audio.destroy(); } catch (error) { /* 平台可能已回收 */ }
    }
    const audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    audio.obeyMuteSwitch = false;
    this._bindAudioEvents(audio);
    return audio;
  },

  /** 对齐 innerAudioContext / BackgroundAudioManager 的公共事件到全局状态机。 */
  _bindAudioEvents(a) {
    a.onCanplay(() => this._emit('canplay'));
    a.onPlay(() => {
      this.failStreak = 0; // 播放成功，失败计数清零
      this._setStatus('playing');
    });
    a.onPause(() => this._setStatus('paused'));
    a.onStop(() => this._setStatus('paused'));
    a.onWaiting(() => this._emit('waiting'));
    a.onError((err) => this._playFailed({
      reason: 'network', code: 'AUDIO',
      message: (err && err.errMsg) || '音频播放出错，请检查网络或音源',
    }));
    a.onEnded(() => this.playNext(true));
    a.onTimeUpdate(() => this._emit('time', {
      current: a.currentTime || 0,
      duration: this._effectiveDuration(a.duration),
    }));
  },

  /** 来电 / 其它 App 抢占音频：记录中断前状态，结束后恢复播放。 */
  _bindInterruptions() {
    if (typeof wx.onAudioInterruptionBegin !== 'function') return;
    wx.onAudioInterruptionBegin(() => {
      this._resumeAfterInterruption = this.isPlaying();
    });
    if (typeof wx.onAudioInterruptionEnd === 'function') {
      wx.onAudioInterruptionEnd(() => {
        if (this._resumeAfterInterruption && this.audio) {
          try { this.audio.play(); } catch (error) { /* 忽略平台回收 */ }
        }
        this._resumeAfterInterruption = false;
      });
    }
  },

  /**
   * 总时长：/api/audio 是流式转发、无 Content-Length，audio.duration 常为 0。
   * 优先用播放器上报的有效时长；否则用列表里已有的 track.duration 兜底，
   * 让进度条 max 恒为正数（onTimeUpdate 拿到有效 duration 后自然覆盖）。
   */
  _effectiveDuration(audioDuration) {
    const d = Number(audioDuration) || 0;
    if (d > 0) return d;
    const track = this.current();
    return Number(track && track.duration) || 0;
  },

  /**
   * 设置音源并起播。BackgroundAudioManager 必填 title（缺它后台/锁屏不显示、可能被拒）；
   * 单例切歌先 stop 再从 0 开始；降级 innerAudioContext 直接换 src。
   */
  _setSrc(track, url) {
    const a = this.audio;
    if (!a) return;
    if (this._useBg) {
      try { a.stop(); } catch (error) { /* 忽略未起播时的 stop */ }
      a.title = track.name || 'PureTone';
      a.singer = track.artist || 'PureTone';
      a.coverImgUrl = track.cover || '';
      a.epname = track.album || 'PureTone';
    }
    a.src = url;
    a.play();
  },

  /** 安全停止：BackgroundAudioManager 是单例，不能 destroy；降级实例的销毁在 _createAudio 重建时做。 */
  _teardownAudio() {
    if (!this.audio) return;
    try { this.audio.stop(); } catch (error) { /* 平台可能已回收 */ }
  },

  _emit(name, detail) {
    // 全局订阅表：谁要持续收事件就得 subscribe（页面在 onLoad 订、onUnload 退）。
    const subs = this._listeners[name];
    if (subs && subs.size) {
      for (const fn of subs) {
        try {
          fn(detail);
        } catch (error) {
          console.error(`[audio:${name}] 订阅回调出错`, error);
        }
      }
    }
    // 兼容旧约定：当前页面实现 onAudioXxx 方法时仍然推送一次。
    const page = getCurrentPages().slice(-1)[0];
    if (page && typeof page[`onAudio${name[0].toUpperCase()}${name.slice(1)}`] === 'function' && !(page._subscribed && page._subscribed.has(name))) {
      page[`onAudio${name[0].toUpperCase()}${name.slice(1)}`](detail);
    }
  },

  /**
   * 订阅全局音频事件。
   * @returns {Function} 取消订阅函数（页面 onUnload 时调用，防泄漏）。
   */
  subscribe(name, fn) {
    if (!this._listeners[name]) this._listeners[name] = new Set();
    this._listeners[name].add(fn);
    return () => this._listeners[name].delete(fn);
  },

  unsubscribe(name, fn) {
    this._listeners[name]?.delete(fn);
  },

  _setStatus(status) {
    this.globalData.status = status;
    this._emit('status', { status });
  },

  /**
   * 从 start 起扫描队列，返回第一个可播（非 VIP/付费）的下标；找不到返回 -1。
   * 向前扫描（含 start，环绕一圈），确定性替代旧的递归 playNext 兜底：
   * 全 VIP 队列只扫一圈就停，绝不死循环。backward=true 时向队首方向扫（playPrev 用）。
   */
  nextPlayableIndex(start, backward = false) {
    const { queue } = this.globalData;
    const len = queue.length;
    if (!len) return -1;
    for (let step = 0; step < len; step += 1) {
      const base = (((start % len) + len) % len + (backward ? len - step : step)) % len;
      const fee = Number(queue[base].fee) || 0;
      // 与服务端 /api/track/:id/url 的门禁对齐：只有 fee 1（VIP）和 4（专辑付费）拦，
      // fee 8 是"非会员免费试听"，可播——之前误把 8 也拦掉，会让扫描绕回唯一免费首。
      if (fee !== 1 && fee !== 4) return base;
    }
    return -1;
  },

  /** 播放指定下标（点到的歌不可播时静默落到下一个可播；全不可播则报错停止）。 */
  playAt(index) {
    this._start(index, false);
  },

  _start(start, backward) {
    const { queue } = this.globalData;
    if (!queue.length) return;
    const target = this.nextPlayableIndex(start, backward);
    if (target === -1) {
      this.globalData.index = -1;
      // 先停（stop 可能触发 onStop → paused），最后再归位 idle 并 emit，避免状态被覆盖
      this._teardownAudio();
      this._setStatus('idle');
      this._emit('error', { reason: 'none_playable', track: queue[start] });
      return;
    }
    const track = queue[target];
    if (target !== start) {
      // 点到的歌不可播：如实报错，然后落到可播目标
      this._emit('error', { reason: 'login_required', track: queue[start] });
    }
    this.globalData.index = target;
    this._setStatus('paused'); // 切歌先归位，等 onPlay 再变 playing
    // 幂等创建 / 复用音频实例（后台单例只绑一次事件；降级 inner 每次重建）
    this.audio = this._createAudio();
    // 先 emit track：让页面立刻拿到 track（含 duration 兜底总时长）
    this._emit('track', { track, index: target, queue });
    // 改走 /api/track/:id/url 门禁：拿同源音源或结构化 reason（无版权 / 风控 / 上游故障 / 需登录）
    const ticket = (this._playTicket += 1);
    api.trackUrl(track.id)
      .then((data) => {
        if (ticket !== this._playTicket) return; // 已被后续点歌覆盖，丢弃过期结果
        this._setSrc(track, absoluteUrl(data.url));
      })
      .catch((err) => {
        if (ticket !== this._playTicket) return;
        this._playFailed(err);
      });
  },

  toggle() {
    const a = this.audio;
    if (!a) return;
    if (!this.isPlaying()) {
      if (!a.src || (this.globalData.index < 0 && this.globalData.queue.length)) {
        this.playAt(0);
        return;
      }
      a.play();
    } else {
      a.pause();
    }
  },

  isPlaying() {
    return this.globalData.status === 'playing';
  },

  current() {
    const { queue, index } = this.globalData;
    return index >= 0 ? queue[index] || null : null;
  },

  playNext(auto) {
    const { index, queue } = this.globalData;
    if (!queue.length) return;
    // 随机模式：从可播集合（排除当前首）里随机挑
    if (this.playMode === 'shuffle' && queue.length > 1) {
      const candidates = [];
      for (let i = 0; i < queue.length; i += 1) {
        const fee = Number(queue[i].fee) || 0;
        if (i !== index && fee !== 1 && fee !== 4) candidates.push(i);
      }
      if (!candidates.length) return; // 没有别的可播，保持当前曲
      this._start(candidates[Math.floor(Math.random() * candidates.length)], false);
      return;
    }
    this._start((index + 1) % queue.length, false);
    // auto=true 表示自然播完切下一首（auto 分支保留给后续策略）。
    void auto;
  },

  playPrev() {
    const { index, queue } = this.globalData;
    if (!queue.length) return;
    this._start((index - 1 + queue.length) % queue.length, true);
  },

  /**
   * 播放失败的统一入口（音频 onError 与上层协议错误都走这里）。
   * 连续失败达到 3 次停止整条链路，避免"一首坏歌拖全队无限横跳"。
   */
  _playFailed(err) {
    this.failStreak += 1;
    if (this.failStreak >= 3) {
      this.failStreak = 0;
      this.globalData.index = -1;
      // 先停（stop 可能触发 onStop → paused），最后统一走 _setStatus('idle') 并 emit，
      // 保证状态归位且页面收到通知，不再谎报「正在播放」
      this._teardownAudio();
      this._setStatus('idle');
      this._emit('error', { reason: 'consecutive_failed', count: 3, last: err });
      return;
    }
    this._emit('error', err);
    this.playNext(true);
  },

  seek(sec) {
    // innerAudioContext 与 BackgroundAudioManager 的 seek 单位都是秒
    if (this.audio) this.audio.seek(Number(sec) || 0);
  },

  fmt(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  },
});
