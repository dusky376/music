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
  },

  onUnload() {
    // 音频实例常驻 app，离开页面只解绑回调引用，不销毁。
  },

  onAudioTrack({ track }) {
    this.setData({ track, lyricLines: [], lyricActive: -1, lyricError: '' });
    this.loadLyric(track);
  },

  onAudioStatus({ status }) {
    this.setData({ isPlaying: status === 'playing' });
  },

  onAudioTime({ current, duration }) {
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

  onAudioError(err) {
    const reason = err && (err.reason || err.code);
    const track = err.track || this.data.track;
    wx.showToast({
      title: ERROR_TEXT[reason] || `《${(track && track.name) || '这首歌'}》暂时无法播放`,
      icon: 'none',
      duration: 2200,
    });
  },

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
    getApp().seek(e.detail.value);
  },
});
