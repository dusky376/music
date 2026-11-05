// PureTone 小程序入口：唯一的音频实例常驻 app，跨页面共享。
// 开发期指向本地后端（需在 DevTools「详情 → 本地设置」勾选"不校验合法域名"）。
// 上线时把 DEV 里的 127.0.0.1:8787 换成已备案的 https 域名即可。
const { BASE } = require('./utils/api.js');

App({
  globalData: {
    queue: [],       // 当前队列（Track[]）
    index: -1,       // 当前曲目下标
    status: 'idle',  // idle | playing | paused | error
  },

  audio: null,

  onLaunch() {
    // 前台保活开关：后台切歌不依赖它，靠 onEnded 驱动。
    this.audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    this.audio.obeyMuteSwitch = false;
    this.audio.onCanplay(() => this._emit('canplay'));
    this.audio.onPlay(() => this._setStatus('playing'));
    this.audio.onPause(() => this._setStatus('paused'));
    this.audio.onStop(() => this._setStatus('paused'));
    this.audio.onWaiting(() => this._emit('waiting'));
    this.audio.onError((err) => this._emit('error', err));
    this.audio.onEnded(() => this.playNext(true));
    this.audio.onTimeUpdate(() => this._emit('time', {
      current: this.audio.currentTime || 0,
      duration: this.audio.duration || 0,
    }));
  },

  _emit(name, detail) {
    // 简版事件：当前页面自行订阅 getPlayer() 挂回调。
    const page = getCurrentPages().slice(-1)[0];
    if (page && typeof page[`onAudio${name[0].toUpperCase()}${name.slice(1)}`] === 'function') {
      page[`onAudio${name[0].toUpperCase()}${name.slice(1)}`](detail);
    }
  },

  _setStatus(status) {
    this.globalData.status = status;
    this._emit('status', { status });
  },

  /** 队列中第 index 首歌（-1 表示空态）。 */
  playAt(index) {
    const { queue } = this.globalData;
    if (index < 0 || index >= queue.length) return;
    const track = queue[index];
    const fee = Number(track.fee) || 0;
    if (fee === 1 || fee === 4 || fee === 8) {
      this.globalData.index = index;
      this._emit('error', { reason: 'login_required', track });
      this.playNext(false);
      return;
    }
    this.globalData.index = index;
    this._setStatus('paused'); // 切歌先归位，等 onPlay 再变 playing
    this.audio.stop();
    this.audio.src = `${BASE}/api/audio/${track.id}`;
    this.audio.play();
    this._emit('track', { track, index, queue });
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
    this.playAt(index + 1 < queue.length ? index + 1 : 0);
    // auto 留给后续做"连续失败停止"计数
  },

  playPrev() {
    const { index, queue } = this.globalData;
    this.playAt(index > 0 ? index - 1 : queue.length - 1);
  },

  seek(sec) {
    this.audio.seek(Number(sec) || 0);
  },

  fmt(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  },
});
