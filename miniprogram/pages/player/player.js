const { api, parseLyrics, lyricIndexAt } = require('../../utils/api.js');

// 歌词平滑滚动：单行高 76rpx；高亮行冻结在距歌词区顶部约 200rpx 的固定位置
// （104 引导空白 - 200 目标位 = 96），与容器实际高度无关，flex 拉伸也不漂移。
const LYRIC_LINE_RPX = 76;
const LYRIC_ANCHOR_RPX = 96;

const ERROR_TEXT = {
  login_required: 'VIP/付费歌曲，登录后才能播放',
  vip_required: '当前账号只能试听',
  no_copyright: '这首歌暂无版权音源',
  risk_control: '登录状态已失效',
  none_playable: '队列里没有可播放的歌',
  consecutive_failed: '连续失败已停止播放',
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
    lyricOffset: 0,  // 歌词滚动位移（rpx），transform 平滑动画用
    playMode: 'order',
    queueOpen: false,
    queueList: [],
    queueIndex: -1,
    audioLoading: false,
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
      // 音频可播放/已起播：摘掉加载指示
      app.subscribe('canplay', () => this.setData({ audioLoading: false })),
    ];
    this.setData({ playMode: app.playMode || 'order' });

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

  handleAudioTrack({ track, index }) {
    this.scrubbing = false;
    const patch = { track, lyricLines: [], lyricActive: -1, lyricError: '', lyricOffset: 0, audioLoading: true };
    if (typeof index === 'number') patch.queueIndex = index;
    this.setData(patch);
    this.loadLyric(track);
  },

  handleAudioStatus({ status }) {
    this.setData({ isPlaying: status === 'playing' });
    if (status === 'playing') this.setData({ audioLoading: false });
  },

  handleAudioTime({ current, duration }) {
    // 拖动中锁住进度条与时间文本，防止 time 事件和 bindchanging 打架回跳。
    if (this.scrubbing) return;
    const app = getApp();
    const activeIdx = lyricIndexAt(this.data.lyricLines, current);
    const patch = {
      current,
      duration: duration || this.data.duration,
      currText: app.fmt(current),
      durText: app.fmt(duration),
    };
    if (activeIdx !== this.data.lyricActive) {
      // 高亮行变化：按累计行高平移歌词（CSS transition 平滑滚动，逐行不是跳变）
      patch.lyricActive = activeIdx;
      patch.lyricOffset = Math.max(0, activeIdx * LYRIC_LINE_RPX - LYRIC_ANCHOR_RPX);
    }
    this.setData(patch);
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
    const idx = lyricIndexAt(this.data.lyricLines, e.detail.value);
    this.setData({
      current: e.detail.value,
      lyricActive: idx,
      lyricOffset: Math.max(0, idx * LYRIC_LINE_RPX - LYRIC_ANCHOR_RPX),
    });
    app.seek(e.detail.value);
  },

  onSliderChanging(e) {
    // 表示拖动开始/进行中， time 事件不再覆盖进度。
    this.scrubbing = true;
    this.setData({ current: e.detail.value });
  },

  // —— 播放模式（顺序/随机） ——
  onCycleMode() {
    const mode = getApp().cycleMode();
    this.setData({ playMode: mode });
    wx.showToast({ title: mode === 'shuffle' ? '随机播放' : '顺序播放', icon: 'none', duration: 900 });
  },

  // —— 队列选歌 ——
  onOpenQueue() {
    const app = getApp();
    this.setData({
      queueOpen: true,
      queueList: app.globalData.queue,
      queueIndex: app.globalData.index,
    });
  },

  onCloseQueue() {
    this.setData({ queueOpen: false });
  },

  onPlayQueueRow(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ queueOpen: false });
    getApp().playAt(index);
  },

  // 点歌词任意行跳到那句（后台 seek，进度/歌词由 time 事件接管）
  onSeekToLyric(e) {
    const app = getApp();
    this.scrubbing = true; // 复用"拖动中"锁：seek 期间 time 事件不回跳旧位置
    app.seek(Number(e.currentTarget.dataset.t) || 0);
    setTimeout(() => { this.scrubbing = false; }, 400);
  },

  noop() {},
});
