// Client-side settings, persisted in localStorage (TZ has no server-side concept of
// this - it's a per-browser budget the user sets for themselves, not an operator guard).

const SETTINGS_KEY = 'ladderfi:settings';

export const DEFAULT_MAX_GAS_FEE_USD = 1;

interface StoredSettings {
  maxGasFeeUsd?: number;
}

function load(): StoredSettings {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getMaxGasFeeUsd(): number {
  const value = load().maxGasFeeUsd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_GAS_FEE_USD;
}

export function setMaxGasFeeUsd(value: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...load(), maxGasFeeUsd: value }));
  } catch {
    // ignore quota/private-mode errors - falls back to DEFAULT_MAX_GAS_FEE_USD next read
  }
}
