const { api, parseLyrics, lyricIndexAt } = require('../../utils/api.js');

// 歌词窗口：flex 吃掉封面与进度条间的全部高度（多出来的面积=多显示几行）。
// 高度随屏而变 → 运行时 SelectorQuery 实测（rpx），未量到按 320 兜底。
// 上下 lead 垫 = (窗口高 - 行高) / 2，动态生成 —— 任意行（含首尾行）都能滚到正中。
const LYRIC_LINE_RPX = 84;
const LYRIC_WINDOW_FALLBACK_RPX = 320;
const LYRIC_LEAD_MIN_RPX = 56;

function lyricLeadRpx(winRpx) {
  return Math.max(LYRIC_LEAD_MIN_RPX, Math.round((winRpx - LYRIC_LINE_RPX) / 2));
}

function lyricMaxOffset(lines) {
  // lead 上 + lead 下 ≈ 窗高 - 行高：滚到最后一句时它正好居中，之后无余量
  return Math.max(0, (lines - 1) * LYRIC_LINE_RPX);
}

/** 高亮第 idx 行时窗口位移：该行正好停在窗口垂直中心（动态 lead 下即 idx * 行高）。 */
function lyricOffsetFor(lines, idx) {
  if (idx <= 0) return 0;
  return Math.min(idx * LYRIC_LINE_RPX, lyricMaxOffset(lines));
}

const ERROR_TEXT = {
  login_required: 'VIP/付费歌曲，请先在网页版扫码登录',
  vip_required: '当前账号只能试听',
  no_copyright: '这首歌暂无版权音源',
  risk_control: '账号触发风控，请稍后再试',
  upstream_error: '上游音乐服务暂时不可用，稍后再试',
  no_audio: '这首歌暂无可用音源',
  network: '网络有点慢，请检查与电脑的 WiFi 连接',
  session: '会话初始化失败，请确认后端已启动并开启 EXPOSE_LAN=1',
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
    lyricLead: 56,     // 上下空白垫（rpx）：实测窗高后重算，保证任意行可居中
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
    // 进度条拖动防抖状态（见 handleAudioTime / 滑动四函数）
    this._lastInt = -1;      // 上次已渲染的整数秒
    this._lastDurInt = -1;   // 上次已渲染的整数时长
    this._scrubValue = null; // 最近一次 bindchanging 报告的拖动位置

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
          // lead = (窗高 - 行高)/2：任意行都能被送到窗口正中
          this.setData({ lyricLead: lyricLeadRpx(this.lyricWindowRpx()) });
          if (this.data.lyricActive >= 0) {
            this.setData({
              lyricOffset: lyricOffsetFor(this.data.lyricLines.length, this.data.lyricActive),
            });
          }
        }
      })
      .exec();
  },

  handleAudioTrack({ track, index }) {
    this.scrubbing = false;
    // 切歌即用列表里的 track.duration 兜底总时长：/api/audio 无 Content-Length，
    // onTimeUpdate 可能长时间给 0，进度条 max 不能是 0（否则拖不动）。
    const dur = Number(track && track.duration) || 1;
    const app = getApp();
    // 重置整秒节流基准，保证新曲第一次 time 事件一定能刷新
    this._lastInt = -1;
    this._lastDurInt = -1;
    const patch = {
      track,
      current: 0,
      duration: dur,
      currText: '0:00',
      durText: app.fmt(dur),
      lyricLines: [],
      lyricActive: -1,
      lyricError: '',
      lyricOffset: 0,
      audioLoading: true,
    };
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
    // 拖动/跳播期间锁住进度条，防止 time 事件把手势打回去（slider"拖不动"的根源之一）。
    if (this.scrubbing) return;
    const activeIdx = lyricIndexAt(this.data.lyricLines, current);
    // 节流：进度条 value 的 setData 降到"整秒或换行"粒度。
    // 高频 setData 会让 slider 持续受控重渲染，在部分设备上直接打断原生拖动手势。
    const intCurrent = Math.floor(current || 0);
    const intDuration = Math.floor(duration || 0);
    const lineChanged = activeIdx !== this.data.lyricActive;
    const tickChanged = intCurrent !== this._lastInt || intDuration !== this._lastDurInt;
    if (!lineChanged && !tickChanged) return;
    this._lastInt = intCurrent;
    this._lastDurInt = intDuration;
    const app = getApp();
    const freeze = Date.now() < (this._lyricFreezeUntil || 0); // 手滑翻看期间，自动跟随让位
    const patch = {
      current,
      duration: duration || this.data.duration,
      currText: app.fmt(current),
      durText: app.fmt(duration),
    };
    if (!freeze && lineChanged) {
      patch.lyricActive = activeIdx;
      patch.lyricOffset = lyricOffsetFor(this.data.lyricLines.length, activeIdx);
    }
    this.setData(patch);
  },

  handleAudioError(err) {
    const reason = err && (err.reason || err.code);
    const track = err.track || this.data.track;
    // 优先用 api 层给出的精确 message（区分 upstream_error / risk_control / 403 等），
    // 否则按 reason 查表，最后才用兜底文案。
    const msg = (err && err.message)
      || ERROR_TEXT[reason]
      || `《${(track && track.name) || '这首歌'}》暂时无法播放`;
    wx.showToast({
      title: msg,
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

  // —— 进度条拖动 ——
  // slider 有三个已知失效层，任何一层失灵都表现为"进度条不能拖动"：
  //   1) bindchanging 首帧前有时间差：触摸瞬间 time 事件就可能回跳 → touchstart 即上锁；
  //   2) value 高频受控重渲染会打断原生拖动手势 → time 事件节流（见 handleAudioTime）；
  //   3) 部分真机吞掉 bindchange，scrubbing 永久为 true → touchend 后 100ms 兜底提交（自愈）。

  onSliderTouchStart() {
    this.scrubbing = true;
  },

  onSliderChanging(e) {
    this.scrubbing = true;
    this._scrubValue = e.detail.value;
    this.setData({ current: e.detail.value });
  },

  onSliderTouchEnd() {
    clearTimeout(this._scrubRelease);
    // 正常路径：bindchange 会紧随其后触发 onSeek（并清掉本定时器）。
    // 如果 change 被吞（个别真机），按最后拖到位置兜底提交，否则进度永远弹回、等于拖不动。
    this._scrubRelease = setTimeout(() => {
      if (this.scrubbing && this._scrubValue != null) this.commitSeek(this._scrubValue);
    }, 100);
  },

  onSeek(e) {
    clearTimeout(this._scrubRelease);
    // 松手位置比拖动过程更准，直接以此为准。
    this.commitSeek(e.detail.value);
  },

  /** 统一的 seek 提交：解锁 + 更新歌词高亮 + 通知 app。 */
  commitSeek(value) {
    this.scrubbing = false;
    this._scrubValue = null;
    const app = getApp();
    const idx = lyricIndexAt(this.data.lyricLines, value);
    this.setData({
      current: value,
      lyricActive: idx,
      lyricOffset: lyricOffsetFor(this.data.lyricLines.length, idx),
    });
    app.seek(value);
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
        lyricOffset: lyricOffsetFor(lines, index),
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
    const max = lyricMaxOffset(this.data.lyricLines.length);
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
