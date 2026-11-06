import { getSimilar } from '../core/api.js';
import { playFromList } from '../core/player.js';

const container = document.getElementById('similarStream');
let requestToken = 0;
let controller = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showState(title, detail, action) {
  container.replaceChildren();
  const box = el('div', 'comments-state');
  box.appendChild(el('div', 'comments-state-icon', '≋'));
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

function createSimilarRow(track, list, index) {
  const row = el('button', 'similar-row');
  row.type = 'button';
  const art = document.createElement('img');
  art.className = 'similar-art';
  art.src = track.cover || '/assets/cover.svg';
  art.alt = '';
  art.width = 42;
  art.height = 42;
  art.loading = 'lazy';
  art.decoding = 'async';

  const meta = el('div', 'similar-meta');
  meta.appendChild(el('span', 'similar-name', track.name));
  meta.appendChild(el('span', 'similar-artist', track.artist));

  row.append(art, meta);
  row.addEventListener('click', () => {
    playFromList(list, index);
  });
  return row;
}

export async function loadSimilar(track) {
  if (!container) return;
  if (!track) {
    showState('还没有播放歌曲', '开始播放后，这里是相近气质的歌。');
    return;
  }
  const token = ++requestToken;
  controller?.abort();
  controller = new AbortController();
  showState('正在寻找相近的歌曲…', track.name);
  try {
    const data = await getSimilar(track.id, { signal: controller.signal });
    if (token !== requestToken) return;
    const list = (data.tracks || []).filter(Boolean);
    container.replaceChildren();
    if (!list.length) {
      showState('暂时没有相似歌曲', '换一首歌试试，或稍后再来。');
      return;
    }
    const fragment = document.createDocumentFragment();
    list.slice(0, 30).forEach((item, index) => fragment.appendChild(createSimilarRow(item, list, index)));
    container.appendChild(fragment);
    container.scrollTop = 0;
  } catch (error) {
    if (token !== requestToken || error?.code === 'ABORTED') return;
    showState('相似歌曲没有加载出来', '网络波动时可以点这里重试。', {
      label: '重新加载',
      onClick: () => loadSimilar(track),
    });
  }
}

export function resetSimilar() {
  requestToken += 1;
  controller?.abort();
}
