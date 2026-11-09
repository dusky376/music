import {
  checkLoginQr,
  createLoginQr,
  getLoginStatusOnce,
  getUser,
  logoutServer,
} from '../core/api.js';
import { emit, on } from '../core/bus.js';
import { saveJSON, loadJSON } from '../core/storage.js';
import { activateDialog, deactivateDialog } from './dialog.js';
import { showToast } from './toast.js';

const overlay = document.getElementById('loginOverlay');
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const closeBtn = document.getElementById('loginCloseBtn');
const qrImg = document.getElementById('loginQrImg');
const qrWrap = document.getElementById('loginQrWrap');
const qrMask = document.getElementById('loginQrMask');
const qrMaskText = document.getElementById('loginQrMaskText');
const qrRefreshBtn = document.getElementById('loginQrRefreshBtn');
const statusEl = document.getElementById('loginStatus');
const logoutBtn = document.getElementById('logoutBtn');
const loginAvatar = document.getElementById('loginAvatar');
const navAccountLinks = [...document.querySelectorAll('.nav-account')];

const STATUS_TEXT = {
  waiting: '等待扫码…（用网易云音乐 App 扫一扫）',
  scanned: '已扫码，请在手机上确认登录',
  expired: '二维码已过期',
  success: '登录成功',
};

let pollTimer = 0;
let state = loadJSON('pt_login', { nickname: '' });
let lastStatus = '';

function setStatus(text) {
  // 文本去重：轮询里相同状态不重复写 DOM，避免 aria-live 每 2 秒打断读屏。
  if (text === lastStatus) return;
  lastStatus = text;
  if (statusEl) statusEl.textContent = text;
}

function setMask(text, visible) {
  if (qrMaskText) qrMaskText.textContent = text || '';
  qrMask?.toggleAttribute('hidden', !visible);
}

export function isLogged() {
  return Boolean(state.nickname);
}

export function nickname() {
  return state.nickname || '';
}

function refreshEntry() {
  if (loginBtnText) {
    loginBtnText.textContent = state.nickname ? `已登录：${state.nickname}` : '扫码登录网易云';
  }
  logoutBtn?.toggleAttribute('hidden', !state.nickname);
  // 账号板块（每日推荐 / 我喜欢的歌曲）只对登录用户显示。
  for (const link of navAccountLinks) link.toggleAttribute('hidden', !state.nickname);
  if (loginAvatar) {
    if (state.avatar) {
      loginAvatar.src = state.avatar;
      loginAvatar.toggleAttribute('hidden', false);
    } else {
      loginAvatar.toggleAttribute('hidden', true);
    }
  }
}

// 登记成功后拉一次资料（头像/昵称），失败静默（昵称兜底已在 state 里）。
async function syncProfile() {
  try {
    const data = await getUser();
    const profile = data?.profile;
    if (!profile) return;
    // 服务端昵称权威：即使本地有"已登录"占位也要覆盖为真名。
    state = { ...state, nickname: profile.nickname || state.nickname || '已登录', avatar: profile.avatar || '' };
    saveJSON('pt_login', state);
    refreshEntry();
  } catch {
    // 拉资料失败不影响登录态本身。
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}

async function startPolling(key, token) {
  stopPolling();
  const tick = async () => {
    if (token !== pollToken) return;
    try {
      const result = await checkLoginQr(key).catch((error) => {
        if (error.status === 401) {
          // 登录态失效正是我们要的效果之一，不当作请求失败。
          return null;
        }
        throw error;
      });
      if (!result || token !== pollToken) return;
      const statusId = result.status;
      if (statusId === 'success') {
        state = { ...state, nickname: result.nickname || '已登录' };
        saveJSON('pt_login', state);
        refreshEntry();
        syncProfile();
        setStatus('登录成功');
        showToast(result.nickname ? `欢迎，${result.nickname}` : '登录成功', 2600);
        stopPolling();
        emit('login:changed', { logged: true });
        setTimeout(closeDialog, 1200);
        return;
      }
      if (statusId === 'scanned') {
        setStatus(STATUS_TEXT.scanned);
      } else if (statusId === 'expired') {
        setMask('二维码已过期', true);
        setStatus(STATUS_TEXT.expired);
        stopPolling();
        return;
      } else {
        // 轮询正常但仍在等待：从网络波动里恢复时把文案纠正回来，
        // 相同文本由 setStatus 去重，不会每 2 秒打断读屏。
        setStatus(STATUS_TEXT.waiting);
      }
    } catch {
      // 仅首次进入失败态写一次，之后相同文本被 setStatus 去重。
      setStatus('网络波动，仍在轮询…');
    }
    pollTimer = setTimeout(tick, 2000);
  };
  pollTimer = setTimeout(tick, 1600);
}

let pollToken = 0;

async function refreshQr() {
  pollToken += 1;
  const token = pollToken;
  stopPolling();
  setMask('', false);
  setStatus('正在拉起二维码…');
  try {
    const { key, qrimg } = await createLoginQr();
    if (token !== pollToken) return;
    const keyStr = key == null ? '' : String(key).trim();
    // 后端保证不回伪 key，前端仍防御：空值、或上游把状态码(如 200)当 unikey。
    if (!keyStr || /^\d+$/.test(keyStr) || !qrimg) {
      // 不设 src、不报「等待扫码」、不启动轮询；显示失败遮罩让用户手动重试。
      setStatus('二维码获取失败，请点击刷新重试');
      setMask('二维码获取失败', true);
      return;
    }
    if (qrImg) qrImg.src = qrimg;
    setStatus(STATUS_TEXT.waiting);
    startPolling(keyStr, token);
  } catch (error) {
    setStatus(`二维码拉取失败：${error.message || '稍后再试'}`);
    setMask('二维码获取失败', true);
  }
}

function openDialog() {
  if (!overlay) return;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  refreshQr();
  refreshEntry();
  // 焦点移入、Tab 循环、底层 inert、关闭后焦点恢复，与其它三个弹窗统一。
  activateDialog(overlay, { initialFocus: closeBtn });
}

export function closeDialog() {
  if (!overlay) return;
  pollToken += 1;
  stopPolling();
  deactivateDialog(overlay);
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
}

export function initLogin() {
  loginBtn?.addEventListener('click', openDialog);
  closeBtn?.addEventListener('click', closeDialog);
  qrRefreshBtn?.addEventListener('click', refreshQr);
  overlay?.addEventListener('click', (event) => {
    if (event.target === overlay) closeDialog();
  });
  overlay?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeDialog();
    }
  });
  logoutBtn?.addEventListener('click', async () => {
    try {
      await logoutServer();
    } catch {
      showToast('退出请求失败，稍后重试', 2000, 'error');
      return;
    }
    state = { nickname: '' };
    saveJSON('pt_login', state);
    refreshEntry();
    closeDialog();
    showToast('已退出登录', 2000);
    emit('login:changed', { logged: false });
  });

  refreshEntry();
  // 启动时对齐一次服务端登录态（例如换浏览器打开时）。
  getLoginStatusOnce()
    .then((info) => {
      const logged = Boolean(info?.logged);
      const localLogged = Boolean(state.nickname);
      if (logged) {
        // 有服务端登录态就同步资料：老用户补头像/真昵称，本地昵称只是占位。
        if (!state.nickname) {
          state = { ...state, nickname: '已登录' };
          saveJSON('pt_login', state);
          refreshEntry();
        }
        syncProfile();
      } else if (state.nickname) {
        state = { nickname: '' };
        saveJSON('pt_login', state);
        refreshEntry();
      }
      // 服务端登录态与本地不一致时广播，供默认筛选以服务端为准重算。
      if (logged !== localLogged) emit('login:changed', { logged });
    })
    .catch(() => {});

  on('login:changed', refreshEntry);
}
