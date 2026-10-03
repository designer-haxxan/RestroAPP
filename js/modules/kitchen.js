// Kitchen display: open kitchen order tickets (KOTs) as big cards. The cook taps Start → Ready; the waiter taps Served.
// Tickets turn orange after 10 minutes and red after 20. Works on this device (or a second window/monitor of it).
import * as UI from '../core/ui.js';
import { esc, fmtQty, fmtTime } from '../core/utils.js';
import { getSettings, pref } from '../core/settings.js';
import { bi, ur, minsSince } from '../core/i18n.js';
import * as Orders from '../services/orders.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;
const T = Orders.ORDER_TYPES;
let station = pref.get('kitchenStation', '');
let seen = null;
let shown = null; // ticket ids on screen: new arrivals slide in
const arrived = new Map(); // ticket id -> time it first appeared (survives quick redraws)

function age(k) {
  const m = (Date.now() - new Date(k.createdAt)) / 60000;
  return m >= 20 ? 'late' : m >= 10 ? 'slow' : 'fresh';
}

let tableNow = new Map(); // orderId -> current table (orders can move after the ticket was made)
function ticket(k) {
  const t = T[k.type] || T.take;
  const now = tableNow.get(k.orderId);
  const where = now && now !== k.tableName ? `${now} (was ${k.tableName || '—'})` : (k.tableName || k.customerName || t.label);
  const next = k.cancelTicket ? ['served', 'OK, seen', 'ٹھیک ہے', 'secondary', 'check2']
    : { new: ['preparing', 'Start', 'شروع کریں', 'warning', 'fire'], preparing: ['ready', 'Ready', 'تیار ہے', 'success', 'check2-circle'], ready: ['served', 'Served', 'پیش کر دیا', 'primary', 'check2-all'] }[k.status];
  return `<div class="kot-card st-${k.status} ${k.cancelTicket ? 'is-cancel' : 'age-' + age(k)}" data-id="${esc(k.id)}">
    <div class="kot-head">
      <span class="kot-no">#${esc(Orders.shortNo(k.number))}</span>
      <span class="kot-where">${t.emoji} ${esc(where)}</span>
      <span class="kot-age"><i class="bi bi-clock"></i> ${minsSince(k.createdAt)}</span>
    </div>
    ${k.cancelTicket ? `<div class="kot-cancel-banner">${bi('CANCEL — do not make', 'منسوخ — مت بنائیں')}</div>` : ''}
    <ul class="kot-items">${k.items.map((i) => `<li class="${i.cancel ? 'x' : ''}"><span class="kq">${fmtQty(i.qty)}×</span><span class="kn">${i.cancel ? '<b>CANCEL</b> ' : ''}${esc(i.name)}${ur(i.nameUr)}${i.note ? `<span class="knote">⚠ ${esc(i.note)}</span>` : ''}</span></li>`).join('')}</ul>
    ${k.note ? `<div class="kot-note">📝 ${esc(k.note)}</div>` : ''}
    <div class="kot-foot">
      <span class="small text-body-secondary">${esc(k.station)} · ${fmtTime(k.createdAt)}${k.waiterName ? ' · ' + esc(k.waiterName) : ''}</span>
      <button class="btn btn-sm btn-light btn-reprint" aria-label="Print again"><i class="bi bi-printer"></i></button>
    </div>
    ${next ? `<button class="btn btn-${next[3]} kot-next" data-next="${next[0]}"><i class="bi bi-${next[4]} me-1"></i>${bi(next[1], next[2])}</button>` : ''}
  </div>`;
}

async function draw($el) {
  const [all, open] = await Promise.all([Orders.kitchenTickets(), Orders.openOrders()]);
  tableNow = new Map(open.filter((o) => o.tableName).map((o) => [o.id, o.tableName]));
  const sts = [...new Set([...Orders.stations(), ...all.map((k) => k.station)])];
  if (station && !sts.includes(station)) station = '';
  const list = all.filter((k) => !station || k.station === station);
  // New ticket arrived since the last look: beep so the cook notices.
  const ids = new Set(all.filter((k) => k.status === 'new').map((k) => k.id));
  if (seen && [...ids].some((id) => !seen.has(id)) && getSettings().restaurant.kitchenSound) { UI.beep(); setTimeout(UI.beep, 180); setTimeout(UI.beep, 360); }
  seen = ids;
  const n = (s) => list.filter((k) => k.status === s).length;
  $el.find('.k-stations').html(sts.length > 1 ? [['', 'All'], ...sts.map((s) => [s, s])].map(([v, l]) => `<button class="chip ${station === v ? 'active' : ''}" data-st="${esc(v)}">${esc(l)}</button>`).join('') : '');
  $el.find('.k-counts').html(`<span class="kc kc-new">${n('new')} ${bi('new', 'نئے')}</span><span class="kc kc-prep">${n('preparing')} ${bi('cooking', 'پک رہے')}</span><span class="kc kc-ready">${n('ready')} ${bi('ready', 'تیار')}</span>`);
  $el.find('.kot-grid').html(list.length ? list.map(ticket).join('') : `<div class="kitchen-empty"><span class="kitchen-empty-emoji">👨‍🍳</span><div>${bi('No orders in the kitchen', 'کچن میں کوئی آرڈر نہیں')}</div></div>`);
  const now = Date.now();
  if (shown === null) UI.animateIn($el.find('.kot-grid'));
  else for (const k of list) if (!shown.has(k.id) && !arrived.has(k.id)) arrived.set(k.id, now);
  $el.find('.kot-card').each(function () { if (now - (arrived.get(this.dataset.id) || 0) < 1500) this.classList.add('kot-arrive'); });
  shown = new Set(list.map((k) => k.id));
}

export default {
  async render(el) {
    seen = null; shown = null;
    const $el = $(el);
    $el.html(`<div class="kitchen-top">
        <div class="k-counts"></div>
        <div class="chips k-stations"></div>
        <button class="btn btn-light btn-full ms-auto" title="Full screen"><i class="bi bi-arrows-fullscreen"></i></button>
      </div>
      <div class="kot-grid"></div>`);
    $el.on('click', '.k-stations [data-st]', function () { station = this.dataset.st; pref.set('kitchenStation', station); draw($el); });
    $el.on('click', '.kot-next', async function () {
      const $c = $(this).closest('.kot-card');
      $(this).prop('disabled', true);
      try { await Orders.setKotStatus($c.data('id'), this.dataset.next); } catch (e) { UI.toastError(e); $(this).prop('disabled', false); }
    });
    $el.on('click', '.btn-reprint', async function () {
      const k = (await Orders.kitchenTickets()).find((x) => x.id === $(this).closest('.kot-card').data('id'));
      if (k) Printer.printKots([k], { silentFail: false }).catch(UI.toastError);
    });
    $el.on('click', '.btn-full', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); });
    await draw($el);
    this._h = () => draw($el).catch(console.warn);
    document.addEventListener('data:changed', this._h);
    this._t = setInterval(this._h, 20000);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    clearInterval(this._t); this._h = null;
  },
};
