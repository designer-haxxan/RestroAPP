// Running orders board: every open order as a big card, with kitchen and delivery status and quick actions.
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty } from '../core/utils.js';
import { getSettings, pref } from '../core/settings.js';
import { bi, minsSince } from '../core/i18n.js';
import * as Orders from '../services/orders.js';
import { renderTables } from './order.js';

const $ = window.jQuery;
const T = Orders.ORDER_TYPES;
const KS = { none: ['Not sent to kitchen', 'کچن نہیں گیا', 'secondary'], new: ['Waiting in kitchen', 'کچن میں انتظار', 'danger'], preparing: ['Cooking', 'پک رہا ہے', 'warning'],
  ready: ['Food ready!', 'کھانا تیار ہے', 'success'], served: ['Served', 'پیش کر دیا', 'primary'] };

let tab = pref.get('ordersTab', 'all');

function card(o) {
  const t = T[o.type];
  const [kl, ku, kc] = KS[o.kitchen] || KS.none;
  const title = o.type === 'dine' ? (o.tableName || 'No table') : (o.customerName || t.label);
  const old = (Date.now() - new Date(o.createdAt)) / 60000;
  return `<div class="ocard ot-${t.color}" data-id="${esc(o.id)}">
    <a class="ocard-body" href="#/order/${encodeURIComponent(o.id)}">
      <div class="ocard-top"><span class="ocard-emoji">${t.emoji}</span><span class="ocard-title">${esc(title)}</span>
        <span class="ocard-time ${old > 45 ? 'late' : ''}"><i class="bi bi-clock"></i> ${minsSince(o.createdAt)}</span></div>
      <div class="ocard-sub">#${esc(Orders.shortNo(o.number))} · ${fmtQty(o.qtyTotal || 0)} items${o.waiterName ? ' · ' + esc(o.waiterName) : ''}${o.phone ? ' · ' + esc(o.phone) : ''}</div>
      ${o.type === 'delivery' && o.address ? `<div class="ocard-sub text-truncate"><i class="bi bi-geo-alt"></i> ${esc(o.address)}</div>` : ''}
      <div class="d-flex align-items-center justify-content-between mt-2">
        <span class="kbadge text-bg-${kc}">${bi(kl, ku)}</span>
        <span class="ocard-total money">${esc(getSettings().currency)} ${fmtNum(o.total)}</span>
      </div>
      ${o.type === 'delivery' ? `<div class="ocard-sub mt-1">🛵 ${o.riderName ? esc(o.riderName) : 'No rider yet'} · <b>${esc(Orders.DELIVERY_STATUS[o.deliveryStatus]?.label || '')}</b></div>` : ''}
    </a>
    <div class="ocard-actions">
      ${o.kitchen === 'ready' ? `<button class="btn btn-success btn-serve"><i class="bi bi-check2-all"></i> ${bi('Served', 'پیش کیا')}</button>` : ''}
      ${o.type === 'delivery' && o.deliveryStatus === 'pending' ? `<button class="btn btn-warning btn-dispatch">🛵 ${bi('Send', 'روانہ')}</button>` : ''}
      <a class="btn btn-primary" href="#/order/${encodeURIComponent(o.id)}/pay"><i class="bi bi-cash-coin"></i> ${bi('Pay', 'ادائیگی')}</a>
    </div>
  </div>`;
}

async function draw($el) {
  const open = await Orders.openOrders();
  const n = (k) => open.filter((o) => o.type === k).length;
  $el.find('.otabs').html([['all', 'All', 'سب', open.length], ...Object.entries(T).map(([k, t]) => [k, `${t.emoji} ${t.label}`, t.ur, n(k)]), ['tables', '🪑 Tables', 'ٹیبلز', '']]
    .map(([k, l, u, c]) => `<button class="otab ${tab === k ? 'active' : ''}" data-tab="${k}">${bi(l, u)}${c !== '' ? `<span class="otab-n">${c}</span>` : ''}</button>`).join(''));
  const $list = $el.find('.olist');
  if (tab === 'tables') { await renderTables($list[0], {}); $list.find('.page-header').remove(); return; }
  const list = open.filter((o) => tab === 'all' || o.type === tab);
  $list.html(list.length ? `<div class="ocard-grid">${list.map(card).join('')}</div>`
    : `<div class="text-center py-5">${UI.emptyState('No running orders', 'check2-circle')}<a class="btn btn-primary btn-lg" href="#/order"><i class="bi bi-plus-lg me-1"></i>${bi('New order', 'نیا آرڈر')}</a></div>`);
}

async function dispatch(id) {
  const staff = (await Orders.allStaff()).filter((s) => s.active && s.role === 'rider');
  const o = (await Orders.openOrders()).find((x) => x.id === id);
  if (!o) return;
  let rider = null;
  if (staff.length) {
    rider = await UI.pick({ title: 'Which rider?', noneLabel: 'Without a rider', search: async (q) => staff.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())).map((s) => ({ id: s.id, title: s.name, subtitle: s.phone || '' })) });
    if (rider === undefined) return;
  }
  try {
    await Orders.saveOrder({ ...o, deliveryStatus: 'on_way', riderId: rider?.id || o.riderId || '', riderName: rider?.title || o.riderName || '' }, { delivery: true });
    UI.toast('Order is on the way');
  } catch (e) { UI.toastError(e); }
}

export default {
  async render(el) {
    const $el = $(el);
    $el.html(`${UI.pageHeader('Running orders', `<a class="btn btn-primary" href="#/order"><i class="bi bi-plus-lg"></i> ${bi('New order', 'نیا آرڈر')}</a>`)}
      <div class="otabs mb-3"></div><div class="olist"></div>`);
    $el.on('click', '.otab', function () { tab = this.dataset.tab; pref.set('ordersTab', tab); draw($el); });
    $el.on('click', '.btn-serve', async function () { await Orders.serveOrder($(this).closest('.ocard').data('id')).catch(UI.toastError); });
    $el.on('click', '.btn-dispatch', function () { dispatch($(this).closest('.ocard').data('id')); });
    await draw($el);
    this._h = () => draw($el).catch(console.warn);
    document.addEventListener('data:changed', this._h);
    this._t = setInterval(this._h, 30000);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    clearInterval(this._t); this._h = null;
  },
};
