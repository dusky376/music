import { on } from '../core/bus.js';

const PALETTES = [
  ['#a9c9ff', '#ffc7bd', '#d9c8ff'],
  ['#ffd1dc', '#c7e8ff', '#ffe6b8'],
  ['#b8f2e6', '#aed9e0', '#ffd6a5'],
  ['#cdb4db', '#ffc8dd', '#bde0fe'],
  ['#ffcad4', '#bde0fe', '#d8f3dc'],
  ['#fbc4ab', '#f9dcc4', '#cdeac0'],
];

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

export function applyAmbient(track) {
  const key = `${track?.id || ''}${track?.cover || ''}` || 'puretone';
  const palette = PALETTES[hash(key) % PALETTES.length];
  const root = document.documentElement;
  root.style.setProperty('--ambient-a', palette[0]);
  root.style.setProperty('--ambient-b', palette[1]);
  root.style.setProperty('--ambient-c', palette[2]);
  root.classList.toggle('has-track', Boolean(track));
}

export function initAmbient() {
  applyAmbient(null);
  on('player:track', ({ track }) => applyAmbient(track));
}
