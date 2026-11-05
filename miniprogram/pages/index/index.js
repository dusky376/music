const { api, SECTIONS } = require('../../utils/api.js');

const SECTION_MEMORY = {}; // 会话内存缓存：切回秒开

Page({
  data: {
    sections: SECTIONS,
    activeKey: SECTIONS[0].key,
    title: SECTIONS[0].title,
    tracks: [],
    loading: false,
    error: '',
  },

  onLoad() {
    this.loadSection(this.data.activeKey);
  },

  switchSection(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeKey) return;
    this.setData({ activeKey: key });
    this.loadSection(key);
  },

  async loadSection(key) {
    const cached = SECTION_MEMORY[key];
    if (cached) {
      // SWR：先渲染缓存，再静默刷新
      this.applySection(key, cached);
      api.section(key).then((data) => this.applySection(key, data)).catch(() => {});
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const data = await api.section(key);
      SECTION_MEMORY[key] = data;
      this.applySection(key, data);
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false, error: err.message || '加载失败' });
    }
  },

  applySection(key, data) {
    if (this.data.activeKey !== key) return; // 竞态保护
    const app = getApp();
    const tracks = (data.tracks || []).map((t) => ({ ...t, durText: app.fmt(t.duration) }));
    this.setData({
      title: data.title || key,
      tracks,
      loading: false,
    });
  },

  onPlayRow(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.playQueue(this.data.tracks, index);
  },

  onPlayAll() {
    if (!this.data.tracks.length) return;
    this.playQueue(this.data.tracks, 0);
  },

  playQueue(tracks, index) {
    const app = getApp();
    app.globalData.queue = tracks.slice();
    app.playAt(index);
    wx.navigateTo({ url: '/pages/player/player' });
  },
});
