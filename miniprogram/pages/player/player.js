const { api, parseLyrics, lyricIndexAt } = require('../../utils/api.js');

// 歌词窗口：flex 吃掉封面与进度条间的全部高度（多出来的面积=多显示几行）。
// 高度随屏而变 → 运行时 SelectorQuery 实测（rpx），未量到按 320 兜底。
const LYRIC_LINE_RPX = 84;
const LYRIC_WINDOW_FALLBACK_RPX = 320;
const LYRIC_LEAD_RPX = 64;      // 与 .lyric-lead 的 64rpx 保持一致（改一处必改另一处）

function lyricMaxOffset(winRpx, lines) {
  return Math.max(0, LYRIC_LEAD_RPX + lines * LYRIC_LINE_RPX - winRpx);
}

/** 高亮第 idx 行时窗口位移：该行顶端停在窗口垂直中心，并夹在可滚范围内。 */
function lyricOffsetFor(winRpx, lines, idx) {
  if (idx <= 0) return 0;
  const desired = LYRIC_LEAD_RPX + idx * LYRIC_LINE_RPX - (winRpx - LYRIC_LINE_RPX) / 2;
  return Math.min(Math.max(0, desired), lyricMaxOffset(winRpx, lines));
}

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
    lyricOffset: 0,    // 歌词窗口位移（rpx），transform 平滑动画用
    lyricDragging: false,
    playMode: 'order',
    queueOpen: false,
    queueList: [],
    queueIndex: -1,
    audioLoading: false,
  },

  onLoad() {
    const app = getApp();
    try {
      this._winWidth = wx.getSystemInfoSync().windowWidth || 375; // rpx↔px 换算基准
    } catch (error) {
      this._winWidth = 375;
    }
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
    // 进入页面时可能已有播放中的曲目：渲染完成后量一次窗口高度
    setTimeout(() => this._measureLyrics(), 80);

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

  /** 歌词窗口高度（rpx）：实测优先（flex 随屏变），失败用常量兜底。 */
  lyricWindowRpx() {
    return this._lyricHeightRpx || LYRIC_WINDOW_FALLBACK_RPX;
  },

  _measureLyrics() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .select('.lyrics')
      .boundingClientRect((rect) => {
        if (rect && rect.height > 0) {
          this._lyricHeightRpx = (rect.height * 750) / (this._winWidth || 375);
          // 已有高亮行时按实测高度重新定位一次
          if (this.data.lyricActive >= 0) {
            this.setData({
              lyricOffset: lyricOffsetFor(this.lyricWindowRpx(), this.data.lyricLines.length, this.data.lyricActive),
            });
          }
        }
      })
      .exec();
  },

  handleAudioTrack({ track, index }) {
    this.scrubbing = false;
    const patch = { track, lyricLines: [], lyricActive: -1, lyricError: '', lyricOffset: 0, audioLoading: true };
    if (typeof index === 'number') patch.queueIndex = index;
    this.setData(patch);
    // 歌词卡 flex 高度随屏渲染：完成后按实测高度重定位
    setTimeout(() => this._measureLyrics(), 60);
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
    const freeze = Date.now() < (this._lyricFreezeUntil || 0); // 手滑翻看期间，自动跟随让位
    const activeIdx = lyricIndexAt(this.data.lyricLines, current);
    const patch = {
      current,
      duration: duration || this.data.duration,
      currText: app.fmt(current),
      durText: app.fmt(duration),
    };
    if (!freeze) {
      if (activeIdx !== this.data.lyricActive) {
        patch.lyricActive = activeIdx;
        patch.lyricOffset = lyricOffsetFor(this.lyricWindowRpx(), this.data.lyricLines.length, activeIdx);
      }
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
      lyricOffset: lyricOffsetFor(this.lyricWindowRpx(), this.data.lyricLines.length, idx),
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
    const index = Number(e.currentTarget.dataset.index);
    const lines = this.data.lyricLines.length;
    if (Number.isInteger(index) && index >= 0 && index < lines) {
      this.setData({
        lyricActive: index,
        lyricOffset: lyricOffsetFor(this.lyricWindowRpx(), lines, index),
      });
    }
    this.scrubbing = true; // 复用"拖动中"锁：seek 期间 time 事件不回跳旧位置
    app.seek(Number(e.currentTarget.dataset.t) || 0);
    setTimeout(() => { this.scrubbing = false; }, 400);
  },

  // —— 歌词手动滑动翻看：冻结自动跟随，松手 3 秒后自动归位（继续跟随高亮行） ——
  onLyricTouchStart(e) {
    this._lyricTouch = {
      startY: e.touches[0].clientY,
      base: this.data.lyricOffset,
    };
    this._lyricFreezeUntil = Date.now() + 4000;
    this.setData({ lyricDragging: true });
  },

  onLyricTouchMove(e) {
    if (!this._lyricTouch) return;
    // clientY 是逻辑像素，位移换算成 rpx（设计稿宽 750）
    const scale = 750 / (this._winWidth || 375);
    const deltaRpx = (this._lyricTouch.startY - e.touches[0].clientY) * scale;
    const max = lyricMaxOffset(this.lyricWindowRpx(), this.data.lyricLines.length);
    const next = Math.min(Math.max(0, this._lyricTouch.base + deltaRpx), max);
    this._lyricFreezeUntil = Date.now() + 4000; // 持续滑动期间持续冻结
    this.setData({ lyricOffset: next });
  },

  onLyricTouchEnd() {
    this._lyricTouch = null;
    this._lyricFreezeUntil = Date.now() + 3000;
    this.setData({ lyricDragging: false });
  },

  noop() {},
});
