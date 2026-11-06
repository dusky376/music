import {
  checkLoginQr,
  createLoginQr,
  getLoginStatus,
  logoutServer,
} from '../core/api.js';
import { on } from '../core/bus.js';
import { saveJSON, loadJSON } from '../core/storage.js';
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

const STATUS_TEXT = {
  waiting: '等待扫码…（用网易云音乐 App 扫一扫）',
  scanned: '已扫码，请在手机上确认登录',
  expired: '二维码已过期',
  success: '登录成功',
};

let pollTimer = 0;
let state = loadJSON('pt_login', { nickname: '' });

function setStatus(text) {
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
        setStatus('登录成功');
        showToast(result.nickname ? `欢迎，${result.nickname}` : '登录成功', 2600);
        stopPolling();
        setTimeout(closeDialog, 1200);
        return;
      }
      if (statusId === 'scanned') setStatus(STATUS_TEXT.scanned);
      if (statusId === 'expired') {
        setMask('二维码已过期', true);
        setStatus(STATUS_TEXT.expired);
        stopPolling();
        return;
      }
    } catch {
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
    if (qrImg) qrImg.src = qrimg || '';
    setStatus(STATUS_TEXT.waiting);
    startPolling(key, token);
  } catch (error) {
    setStatus(`二维码拉取失败：${error.message || '稍后再试'}`);
  }
}

function openDialog() {
  if (!overlay) return;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  refreshQr();
  refreshEntry();
}

export function closeDialog() {
  if (!overlay) return;
  pollToken += 1;
  stopPolling();
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
  });

  refreshEntry();
  // 启动时对齐一次服务端登录态（例如换浏览器打开时）。
  getLoginStatus()
    .then((info) => {
      if (info?.logged && !state.nickname) {
        state = { ...state, nickname: state.nickname || '已登录' };
        saveJSON('pt_login', state);
        refreshEntry();
      } else if (!info?.logged && state.nickname) {
        state = { nickname: '' };
        saveJSON('pt_login', state);
        refreshEntry();
      }
    })
    .catch(() => {});

  on('login:changed', refreshEntry);
}
