const { api, SECTIONS, ACCOUNT_SECTIONS } = require('../../utils/api.js');

const SECTION_MEMORY = {}; // 会话内存缓存：切回秒开

Page({
  data: {
    sections: SECTIONS,
    activeKey: SECTIONS[0].key,
    title: SECTIONS[0].title,
    tracks: [],
    loading: false,
    error: '',
    account: { logged: false, nickname: '', avatar: '' },
  },

  onLoad() {
    this.loadSection(this.data.activeKey);
    this.syncAccount();
  },

  // 从网页版扫码登录后切回小程序，这里同步一次登录态与账号板块可见性。
  onShow() {
    if (this.__loaded) this.syncAccount();
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
      if (err.code === 'HTTP_401') {
        // 账号板块未登录：如实提示，并隐藏账号入口
        wx.showToast({ title: '请先在网页版扫码登录', icon: 'none', duration: 2600 });
        this.setData({ loading: false, error: '', tracks: [], title: '需要登录', sections: SECTIONS });
        this.syncAccount();
        return;
      }
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

  /** 同步服务端登录态：登录后有头像昵称与账号板块；退出或未登录则隐藏。 */
  syncAccount() {
    api.user()
      .then((data) => {
        const profile = data?.profile;
        const logged = Boolean(data?.logged && profile);
        this.setData({
          account: {
            logged,
            nickname: logged ? profile.nickname || '已登录' : '',
            avatar: logged ? profile.avatar || '' : '',
          },
          sections: logged ? [...SECTIONS, ...ACCOUNT_SECTIONS] : SECTIONS,
        });
        // 如果当前停在被移除的板块上，回落到第一个基础板块
        if (!logged && ACCOUNT_SECTIONS.some((s) => s.key === this.data.activeKey)) {
          this.setData({ activeKey: SECTIONS[0].key });
          this.loadSection(SECTIONS[0].key);
        }
      })
      .catch(() => {
        // 服务不可达时保留现状，不打断使用
      });
  },

  onPlayRow(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.playQueue(this.data.tracks, index);
  },

  // 单曲封面在网易 CDN 404（封面被下架）时换灰色占位，不冒破图。
  onCoverError(e) {
    const index = Number(e.currentTarget.dataset.index);
    const track = this.data.tracks[index];
    if (!track || track.coverBroken) return;
    this.setData({ [`tracks[${index}].coverBroken`]: true });
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
