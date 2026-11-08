// PureTone 小程序入口：唯一的音频实例常驻 app，跨页面共享。
// 开发期指向本地后端（需在 DevTools「详情 → 本地设置」勾选"不校验合法域名"）。
// 上线时把 DEV 里的 127.0.0.1:8787 换成已备案的 https 域名即可。
const { BASE } = require('./utils/api.js');

App({
  _listeners: {},

  globalData: {
    queue: [],       // 当前队列（Track[]）
    index: -1,       // 当前曲目下标
    status: 'idle',  // idle | playing | paused | error
  },

  audio: null,
  failStreak: 0,

  _createAudio() {
    const audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    audio.obeyMuteSwitch = false;
    audio.onCanplay(() => this._emit('canplay'));
    audio.onPlay(() => {
      this.failStreak = 0; // 播放成功，失败计数清零
      this._setStatus('playing');
    });
    audio.onPause(() => this._setStatus('paused'));
    audio.onStop(() => this._setStatus('paused'));
    audio.onWaiting(() => this._emit('waiting'));
    audio.onError((err) => this._playFailed(err));
    audio.onEnded(() => this.playNext(true));
    audio.onTimeUpdate(() => this._emit('time', {
      current: audio.currentTime || 0,
      duration: audio.duration || 0,
    }));
    return audio;
  },

  onLaunch() {
    this.audio = this._createAudio();
  },

  _teardownAudio() {
    if (!this.audio) return;
    for (const fn of ['stop', 'destroy']) {
      try {
        this.audio[fn]();
      } catch (error) {
        // destroy 时平台可能已回收，忽略
      }
    }
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
      this._setStatus('idle');
      this.audio.stop();
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
    // 换源必须销毁重建实例：部分平台/DevTools 的 setter 换 src 会继承上一个音源的
    // 播放位置，表现为"点下一首，接着上一首的秒数继续播"。重建保证从 0 开始。
    this._teardownAudio();
    this.audio = this._createAudio();
    this.audio.src = `${BASE}/api/audio/${track.id}`;
    this.audio.play();
    this._emit('track', { track, index: target, queue });
  },

  toggle() {
    const a = this.audio;
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
      this.globalData.status = 'idle';
      this.audio.stop();
      this._emit('error', { reason: 'consecutive_failed', count: 3, last: err });
      return;
    }
    this._emit('error', err);
    this.playNext(true);
  },

  seek(sec) {
    this.audio.seek(Number(sec) || 0);
  },

  fmt(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  },
});
