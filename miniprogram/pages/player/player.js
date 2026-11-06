const { api, parseLyrics, lyricIndexAt } = require('../../utils/api.js');

const ERROR_TEXT = {
  login_required: 'VIP/付费歌曲，登录后才能播放',
  vip_required: '当前账号只能试听',
  no_copyright: '这首歌暂无版权音源',
  risk_control: '登录状态已失效',
  NETWORK: '网络有点慢，歌曲没有加载出来',
};

Page({
  data: {
    track: null,
    isPlaying: false,
    current: 0,
    duration: 0,
    currText: '0:00',
    durText: '0:00',
    lyricLines: [],
    lyricActive: -1,
    lyricError: '',
  },

  onLoad() {
    const app = getApp();
    // 订阅制：页面常驻 app 事件总线，onUnload 统一退订。
    // 事件名登记进 _subscribed 后，app._emit 的旧当前页兜底推送会对本页关闭，避免重复。
    this._subscribed = new Set(['time', 'status', 'track', 'error']);
    this._subs = [
      app.subscribe('time', (d) => this.handleAudioTime(d)),
      app.subscribe('status', (d) => this.handleAudioStatus(d)),
      app.subscribe('track', (d) => this.handleAudioTrack(d)),
      app.subscribe('error', (d) => this.handleAudioError(d)),
    ];

    const track = app.current();
    if (!track) {
      const { queue } = app.globalData;
      if (queue.length) {
        app.playAt(0);
        this.setData({ track: queue[0] });
      }
    } else {
      this.setData({ track });
      this.loadLyric(track);
    }
  },

  onShow() {
    const app = getApp();
    const track = app.current();
    if (track && (!this.data.track || track.id !== this.data.track.id)) {
      this.setData({ track });
    }
    if (track) this.setData({ isPlaying: app.isPlaying() });
    // 已知坑修复：从其它页面回来时，可能残留"拖动中"状态导致进度冻结不刷新。
    this.scrubbing = false;
  },

  onUnload() {
    // 音频实例常驻 app；页面只解绑自己的订阅，防泄漏。
    (this._subs || []).forEach((dispose) => dispose());
    this._subs = [];
  },

  handleAudioTrack({ track }) {
    this.scrubbing = false;
    this.setData({ track, lyricLines: [], lyricActive: -1, lyricError: '' });
    this.loadLyric(track);
  },

  handleAudioStatus({ status }) {
    this.setData({ isPlaying: status === 'playing' });
  },

  handleAudioTime({ current, duration }) {
    // 拖动中锁住进度条与时间文本，防止 time 事件和 bindchanging 打架回跳。
    if (this.scrubbing) return;
    const app = getApp();
    const activeIdx = lyricIndexAt(this.data.lyricLines, current);
    this.setData({
      current,
      duration: duration || this.data.duration,
      currText: app.fmt(current),
      durText: app.fmt(duration),
      lyricActive: activeIdx === this.data.lyricActive ? this.data.lyricActive : activeIdx,
    });
  },

  handleAudioError(err) {
    const reason = err && (err.reason || err.code);
    const track = err.track || this.data.track;
    wx.showToast({
      title: ERROR_TEXT[reason] || `《${(track && track.name) || '这首歌'}》暂时无法播放`,
      icon: 'none',
      duration: 2200,
    });
  },

  // 兼容标注：以下 4 个不再是 app 直接调用的"协议方法"，仅为保留旧命名方便排错。
  onAudioTrack(d) { this.handleAudioTrack(d); },
  onAudioStatus(d) { this.handleAudioStatus(d); },
  onAudioTime(d) { this.handleAudioTime(d); },
  onAudioError(d) { this.handleAudioError(d); },

  loadLyric(track) {
    if (!track) return;
    api.lyric(track.id)
      .then((data) => {
        const lines = parseLyrics(data.lrc);
        this.setData({
          lyricLines: lines,
          lyricActive: -1,
          lyricError: lines.length ? '' : '这首歌暂无歌词',
        });
      })
      .catch((err) => this.setData({ lyricError: err.message || '歌词加载失败' }));
  },

  onToggle() {
    getApp().toggle();
  },

  onPrev() {
    getApp().playPrev();
  },

  onNext() {
    getApp().playNext(false);
  },

  onSeek(e) {
    const app = getApp();
    this.scrubbing = false;
    // 松手位置比拖动过程更准，直接以此为准。
    this.setData({ current: e.detail.value });
    app.seek(e.detail.value);
  },

  onSliderChanging(e) {
    // 表示拖动开始/进行中， time 事件不再覆盖进度。
    this.scrubbing = true;
    this.setData({ current: e.detail.value });
  },
});
