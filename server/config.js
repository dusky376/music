import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';
export const UPSTREAM = (process.env.NETEASE_API || 'https://apis.netstart.cn/music').replace(/\/+$/, '');
export const COOKIE = process.env.NETEASE_COOKIE || '';
export const WARM = process.env.WARM !== '0';
export const CACHE_TTL = {
  section: 10 * 60 * 1000,
  tracks: 10 * 60 * 1000,
  category: 6 * 60 * 60 * 1000,
  search: 5 * 60 * 1000,
  lyric: 24 * 60 * 60 * 1000,
  comments: 5 * 60 * 1000,
  similar: 60 * 60 * 1000,
  audio: 10 * 60 * 1000,
};

export const LEVELS = ['standard', 'higher', 'exhigh', 'lossless'];

export const SECTIONS = Object.freeze({
  top_19723756: {
    type: 'top',
    id: '19723756',
    title: '飙升榜',
    subtitle: '极速蹿升的热门单曲',
    limit: 80,
  },
  top_3778678: {
    type: 'top',
    id: '3778678',
    title: '热歌榜',
    subtitle: '云音乐播放热度前列曲目',
    limit: 80,
  },
  top_3779629: {
    type: 'top',
    id: '3779629',
    title: '新歌榜',
    subtitle: '流行乐坛最新发声作品',
    limit: 80,
  },
  cat_华语: {
    type: 'cat',
    cat: '华语',
    playlistId: '7572518150',
    title: '华语精选',
    subtitle: '群星汇聚的优质华语热歌',
    limit: 80,
  },
  cat_欧美: {
    type: 'cat',
    cat: '欧美',
    playlistId: '8185867741',
    title: '欧美精选',
    subtitle: '欧美流行与治愈系热单',
    limit: 80,
  },
  cat_摇滚: {
    type: 'cat',
    cat: '摇滚',
    playlistId: '9161387200',
    title: '摇滚现场',
    subtitle: '自由、失真与呐喊',
    limit: 80,
  },
  cat_学习: {
    type: 'cat',
    cat: '学习',
    playlistId: '8155172622',
    title: '专注氛围',
    subtitle: 'Lofi 与轻节拍，陪你进入心流',
    limit: 80,
  },
});

export function getSectionConfig(key) {
  return SECTIONS[key] || null;
}
