// Lightweight settings/preferences stored in LocalStorage (never operational data or secrets).
import { storageKey } from '../config.js';

const KEY = storageKey('settings');

export const DEFAULT_SETTINGS = {
  business: { name: 'My Restaurant', address: '', phone: '', taxNo: '', footer: 'Thank you! Please visit again.' },
  currency: 'Rs',
  taxEnabled: false,
  taxRate: 0,
  allowNegativeStock: true,
  updatePurchasePrice: true,
  prefixes: { sale: 'BILL', purchase: 'PUR', saleReturn: 'SRN', purchaseReturn: 'PRN', receipt: 'RCV', payment: 'PAY', transfer: 'TRF', adjustment: 'ADJ', order: 'ORD', kot: 'KOT' },
  printer: { method: 'browser', width: 58, autoPrint: true, copies: 1, chunkSize: 20, imageMode: 'gsv0', deviceName: '', deviceId: '', kotPrint: true },
  restaurant: {
    showUrdu: true,            // Urdu labels under English ones on the ordering screens
    deliveryCharge: 0,         // default delivery charge for delivery orders
    serviceCharge: 0,          // % service charge on dine-in bills
    stations: 'Kitchen',       // kitchen stations (comma separated), e.g. "Kitchen, BBQ, Drinks"
    quickNotes: 'Less spicy, Extra spicy, No onion, Extra sauce, Well done, Pack separately',
    kitchenSound: true,
  },
  theme: 'auto',
  register: 'Main',
};

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

let cache = null;
export function getSettings() {
  if (!cache) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { stored = {}; }
    cache = merge(DEFAULT_SETTINGS, stored);
  }
  return cache;
}

export function saveSettings(patch) {
  cache = merge(getSettings(), patch);
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
  return cache;
}

export function replaceSettings(all) {
  cache = merge(DEFAULT_SETTINGS, all || {});
  localStorage.setItem(KEY, JSON.stringify(cache));
  document.dispatchEvent(new CustomEvent('settings:changed', { detail: cache }));
}

// Small per-device preference helpers
export const pref = {
  get(k, d = null) { try { const v = localStorage.getItem(storageKey('pref.' + k)); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(storageKey('pref.' + k), JSON.stringify(v)); },
};

export function applyTheme() {
  const t = getSettings().theme;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1d21' : '#e8590c');
}
