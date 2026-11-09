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
    now: null,       // 迷你播放条数据（当前曲目）
    nowPlaying: false,
  },

  onLoad() {
    // 板块以服务端 /api/sections 为准（含「新歌榜」）；拉取失败时退回本地兜底列表。
    this._baseSections = SECTIONS;
    this.loadSection(this.data.activeKey);
    this.syncAccount();
    this.syncNow();
    this.loadSections();
    // 迷你条跟随全局播放状态：切歌/播放暂停即刻反映
    const app = getApp();
    this._subs = [
      app.subscribe('track', () => this.syncNow()),
      app.subscribe('status', () => this.syncNow()),
    ];
  },

  onUnload() {
    (this._subs || []).forEach((dispose) => dispose());
    this._subs = [];
  },

  /**
   * 每次回到前台都刷新：网页版扫码登录后切回小程序、从播放页返回都能同步，不必冷启动。
   * （替代旧版 this.__loaded 死代码——该字段全项目无赋值，onShow 永远不执行刷新）
   * skipAutoNav=true：切回前台只更新登录态 / 板块可见性，不自动跳到「每日推荐」。
   */
  onShow() {
    this.syncAccount(true);
    this.syncNow();
  },

  /** 拉取服务端板块清单；成功则以服务端为准，失败静默保留本地兜底，不打断使用。 */
  loadSections() {
    api.sections()
      .then((list) => {
        if (!list.length) return;
        this._baseSections = list;
        if (!list.some((s) => s.key === this.data.activeKey)) {
          this.setData({ activeKey: list[0].key });
          this.loadSection(list[0].key);
        }
        this.applySections();
      })
      .catch(() => {
        // 后端未实现 /api/sections 或不可达：保留本地兜底 SECTIONS
      });
  },

  /** 按登录态把账号板块拼到基础板块前，写回 data.sections。 */
  applySections(logged) {
    const base = this._baseSections || SECTIONS;
    const isLogged = logged === undefined ? this.data.account.logged : logged;
    this.setData({ sections: isLogged ? [...ACCOUNT_SECTIONS, ...base] : base });
  },

  /** 同步迷你播放条：有没有歌在播 + 是否 playing。 */
  syncNow() {
    const app = getApp();
    const track = app.current();
    this.setData({
      now: track,
      nowPlaying: app.isPlaying(),
    });
  },

  onToggleNow() {
    getApp().toggle();
  },

  onOpenPlayer() {
    wx.navigateTo({ url: '/pages/player/player' });
  },

  switchSection(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeKey) return;
    this.userTouched = true; // 用户手动切过板块后，账号同步不再自动跳页
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
        this.setData({ loading: false, error: '', tracks: [], title: '需要登录', sections: this._baseSections || SECTIONS });
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

  /**
   * 同步服务端登录态：登录后有头像昵称与账号板块；退出或未登录则隐藏。
   * skipAutoNav=true 时不做「登录成功自动跳每日推荐」（切回前台的被动刷新用）。
   */
  syncAccount(skipAutoNav = false) {
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
        });
        this.applySections(logged);
        const base = this._baseSections || SECTIONS;
        if (!logged && ACCOUNT_SECTIONS.some((s) => s.key === this.data.activeKey)) {
          this.setData({ activeKey: base[0].key });
          this.loadSection(base[0].key);
          return;
        }
        // 登录成功且用户没手动换过页、且不是切回前台的被动刷新：默认落在「每日推荐」
        if (logged && !skipAutoNav && this.data.activeKey === base[0].key && !this.userTouched) {
          this.setData({ activeKey: ACCOUNT_SECTIONS[0].key });
          this.loadSection(ACCOUNT_SECTIONS[0].key);
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
