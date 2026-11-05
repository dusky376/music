import { getComments } from '../core/api.js';

const container = document.getElementById('commentsStream');
let requestToken = 0;
let controller = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeAvatar(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function formatLiked(value) {
  const count = Number(value) || 0;
  if (count >= 10000) return `${(count / 10000).toFixed(1).replace('.0', '')} 万`;
  return String(count);
}

function showState(title, detail, action) {
  container.replaceChildren();
  const box = el('div', 'comments-state');
  box.appendChild(el('div', 'comments-state-icon', '“'));
  box.appendChild(el('h3', '', title));
  if (detail) box.appendChild(el('p', '', detail));
  if (action) {
    const button = el('button', 'ghost-button', action.label);
    button.type = 'button';
    button.addEventListener('click', action.onClick);
    box.appendChild(button);
  }
  container.appendChild(box);
}

function createComment(comment) {
  const bubble = el('article', 'comment-bubble');
  const avatarUrl = safeAvatar(comment.user?.avatar);
  if (avatarUrl) {
    const img = document.createElement('img');
    img.className = 'comment-user-pic';
    img.src = avatarUrl;
    img.alt = '';
    img.width = 38;
    img.height = 38;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      const fallback = el('div', 'comment-user-pic comment-avatar-fallback', (comment.user?.nickname || '匿')[0]);
      img.replaceWith(fallback);
    });
    bubble.appendChild(img);
  } else {
    bubble.appendChild(el('div', 'comment-user-pic comment-avatar-fallback', (comment.user?.nickname || '匿')[0]));
  }

  const body = el('div', 'comment-content-box');
  const head = el('div', 'comment-header');
  head.appendChild(el('span', 'comment-author', comment.user?.nickname || '匿名用户'));
  head.appendChild(el('span', 'comment-liked', `♥ ${formatLiked(comment.liked)}`));
  body.appendChild(head);
  body.appendChild(el('p', 'comment-text', comment.content));
  if (comment.timeStr) body.appendChild(el('span', 'comment-time', comment.timeStr));
  bubble.appendChild(body);
  return bubble;
}

export async function loadComments(track) {
  if (!container) return;
  if (!track) {
    showState('还没有播放歌曲', '开始播放后，这里会出现热门评论。');
    return;
  }
  const token = ++requestToken;
  controller?.abort();
  controller = new AbortController();
  showState('正在获取热门评论…', track.name);
  try {
    const data = await getComments(track.id, { signal: controller.signal });
    if (token !== requestToken) return;
    const list = data.comments || [];
    container.replaceChildren();
    if (!list.length) {
      showState('还没有热评', '这首歌暂时很安静，先听歌吧。');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const comment of list) fragment.appendChild(createComment(comment));
    container.appendChild(fragment);
    container.scrollTop = 0;
  } catch (error) {
    if (token !== requestToken || error?.code === 'ABORTED') return;
    showState('评论没有加载出来', '网络波动时可以点这里重试。', {
      label: '重新加载评论',
      onClick: () => loadComments(track),
    });
  }
}
