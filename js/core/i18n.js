// Bilingual labels for the restaurant screens: English with Urdu underneath, so staff who read only Urdu
// (or read little at all, helped by the emoji and colours) can use the app. Toggle: Settings → Restaurant.
import { getSettings } from './settings.js';
import { esc } from './utils.js';

export const urduOn = () => getSettings().restaurant?.showUrdu !== false;

// <span>English</span><span>اردو</span>
export const bi = (en, ur) => `<span class="lbl-en">${esc(en)}</span>${urduOn() && ur ? `<span class="lbl-ur" dir="rtl" lang="ur">${esc(ur)}</span>` : ''}`;
// Urdu text on its own line (e.g. a dish's Urdu name), hidden when Urdu is off.
export const ur = (text) => (urduOn() && text ? `<span class="lbl-ur" dir="rtl" lang="ur">${esc(text)}</span>` : '');

export function minsSince(iso) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
