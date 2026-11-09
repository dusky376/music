// 后端地址配置（开发 / 真机 / 上线三态，单一来源）。
//
// 优先级：本地存储覆盖 > 本文件默认常量。
//   - 开发 / 真机：把 DEFAULT_BASE_URL 改成电脑的内网 IP + 端口（手机与电脑同一 WiFi），
//     后端必须以 EXPOSE_LAN=1 启动才会监听内网 IP；并在微信开发者工具
//     「详情 → 本地设置」勾选「不校验合法域名」。
//   - 也可运行时用 wx.setStorageSync('pt_base_url', 'http://192.168.x.x:8787')
//     覆盖，免去改代码（改完重启小程序生效）。
//   - 模拟器可用 http://127.0.0.1:8787；真机不能用 127.0.0.1（那是手机自己）。
//   - 正式上线：必须换成 https + 已备案域名（微信不支持 IP / 端口 / 内网地址），
//     并关闭 urlCheck:false、配置合法域名。当前项目不具备上线条件，详见 README。

// 默认后端地址：改这里即改全局；也可由 pt_base_url 覆盖。
const DEFAULT_BASE_URL = 'http://192.168.4.12:8787';

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function getBaseUrl() {
  try {
    const override = wx.getStorageSync('pt_base_url');
    if (override && typeof override === 'string' && override.trim()) {
      return normalizeBase(override);
    }
  } catch (error) {
    // 存储不可用时回落到默认常量
  }
  return normalizeBase(DEFAULT_BASE_URL);
}

const BASE_URL = getBaseUrl();

module.exports = { BASE_URL, DEFAULT_BASE_URL, getBaseUrl };
