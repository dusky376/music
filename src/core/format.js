export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60);
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
