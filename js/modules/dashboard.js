// Restaurant home: big action tiles, today's figures (from transaction records), running orders, best sellers, alerts.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, today, round2 } from '../core/utils.js';
import { money } from '../core/views.js';
import { pref, getSettings } from '../core/settings.js';
import { bi, minsSince } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Orders from '../services/orders.js';
import * as Backup from '../services/backup.js';

const $ = window.jQuery;

function greet() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
const greetEmoji = () => { const h = new Date().getHours(); return h < 12 ? '☀️' : h < 17 ? '👋' : '🌙'; };

export async function todayFigures(date = today()) {
  const r = IDBKeyRange.only(date);
  const [sales, items, sret, vouchers, kots] = await idb.read(['sales', 'saleItems', 'saleReturns', 'vouchers', 'kots'], (t) => Promise.all([
    t.getAllByIndex('sales', 'date', r), t.getAllByIndex('saleItems', 'date', r), t.getAllByIndex('saleReturns', 'date', r),
    t.getAllByIndex('vouchers', 'date', r), t.getAllByIndex('kots', 'date', r),
  ]));
  const live = (x) => x.filter((d) => d.status !== 'void');
  const s = live(sales);
  const byType = { dine: [0, 0], take: [0, 0], delivery: [0, 0], counter: [0, 0] };
  for (const d of s) { const k = byType[d.order?.type] ? d.order.type : 'counter'; byType[k][0] += d.total; byType[k][1]++; }
  const saleIds = new Set(s.map((d) => d.id));
  const top = new Map();
  for (const i of items) {
    if (!saleIds.has(i.saleId)) continue;
    const x = top.get(i.productId) || { name: i.name, qty: 0, amount: 0 };
    x.qty += i.qty; x.amount += i.amount; top.set(i.productId, x);
  }
  const pays = live(vouchers).filter((v) => v.type === 'payment');
  return {
    sales: round2(s.reduce((a, d) => a + d.total, 0)), bills: s.length, byType,
    collected: round2(s.reduce((a, d) => a + d.paid, 0)), credit: round2(s.reduce((a, d) => a + d.balance, 0)),
    returns: round2(live(sret).reduce((a, d) => a + d.total, 0)),
    expenses: round2(pays.filter((v) => v.counterType === 'expense' && !v.staffId).reduce((a, v) => a + v.amount, 0)),
    salaries: round2(pays.filter((v) => v.staffId).reduce((a, v) => a + v.amount, 0)),
    kots: kots.filter((k) => !k.cancelTicket).length,
    top: [...top.values()].sort((a, b) => b.qty - a.qty).slice(0, 6),
  };
}

export default {
  async render(el, ctx = {}) {
    this.destroy();
    clearInterval(this._clock);
    const $el = $(el);
    const u = Auth.user();
    const [f, bal, open, tickets, accounts, nTables, nStaff, nSales] = await Promise.all([todayFigures(), Posting.allBalances(), Orders.openOrders(), Orders.kitchenTickets(),
      idb.getAll('accounts'), idb.count('tables'), idb.count('staff'), idb.count('sales')]);
    // First-run checklist: shown until the essentials are done (or hidden by the owner).
    const steps = [
      ['#/settings', '🏪', 'Restaurant name, address & printer', 'نام، پتہ اور پرنٹر', getSettings().business.name !== 'My Restaurant'],
      ['#/products', '🍛', 'Add your menu with prices', 'مینو اور قیمتیں', Catalog.allProducts().some((p) => Catalog.kindOf(p) === 'menu')],
      ['#/tables', '🪑', 'Add your tables', 'ٹیبلز', nTables > 0],
      ['#/staff', '🧑‍🍳', 'Add staff (waiters, riders, cooks)', 'عملہ', nStaff > 0],
    ];
    const showSetup = Auth.can('settings.manage') && pref.get('setupHidden') !== true && steps.slice(0, 3).some((s) => !s[4]);
    const cashIn = round2(accounts.filter((a) => ['cash', 'bank'].includes(a.type) && a.active).reduce((s, a) => s + (bal.get(a.id)?.balance || 0), 0));
    const low = Catalog.allProducts().filter((p) => p.active && p.trackStock !== false && p.stock <= (p.minStock || 0)).sort((a, b) => a.stock - b.stock);
    const cookNow = tickets.filter((k) => k.status !== 'ready' && !k.cancelTicket).length;
    const readyNow = tickets.filter((k) => k.status === 'ready').length;
    const lastBackup = pref.get('lastBackupAt');
    const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : null;
    const cur = (n) => money(n);
    const tile = (href, emoji, en, urd, cls, badge = '', perm = null) => (!perm || Auth.can(perm)) ? `<a class="home-tile ${cls}" href="${href}"><span class="home-emoji">${emoji}</span><span class="home-label">${bi(en, urd)}</span>${badge !== '' && badge !== 0 ? `<span class="home-badge">${badge}</span>` : ''}</a>` : '';
    const stat = (label, value, sub = '', href = null) => `<div class="col-6 col-md-4 col-xl-2"><${href ? `a href="${href}"` : 'div'} class="card stat-card h-100 text-decoration-none"><div class="card-body py-2 px-3">
      <div class="stat-label">${label}</div><div class="stat-value money" data-count="${Number(String(value).replace(/[^\d.-]/g, '')) || 0}">${value}</div>${sub ? `<div class="small text-body-secondary">${sub}</div>` : ''}</div></${href ? 'a' : 'div'}></div>`;
    const T = Orders.ORDER_TYPES;
    $el.html(`
      <section class="hero mb-3">
        <div class="hero-text">
          <div class="hero-date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · <span class="hero-clock"></span></div>
          <h1 class="hero-hello">${greet()}, ${esc(u.name.split(' ')[0])} ${greetEmoji()}</h1>
          <div class="hero-biz">${esc(getSettings().business.name)}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">${bi("Today's sales", 'آج کی سیل')}</div>
          <div class="hero-stat-value money" data-count="${f.sales}">${cur(f.sales)}</div>
          <div class="hero-stat-sub">${f.bills} bills · ${open.length} running</div>
        </div>
        <div class="hero-food" aria-hidden="true">🍛🍢🥤</div>
      </section>
      ${!navigator.onLine ? '<div class="alert alert-secondary py-2 small"><i class="bi bi-wifi-off me-1"></i>You are offline. Everything is saved on this device.</div>' : ''}
      <div class="legacy-hint"></div>
      ${Auth.can('backup.export') && nSales > 0 && (backupDays === null || backupDays >= 7) ? `<div class="alert alert-warning py-2 small d-flex align-items-center gap-2"><i class="bi bi-exclamation-triangle"></i><div class="flex-grow-1">${backupDays === null ? 'No backup has been made on this device yet.' : `Last backup was ${backupDays} days ago.`} Your data only lives on this device.</div><a class="btn btn-sm btn-warning" href="#/backup">Back up</a></div>` : ''}
      ${showSetup ? `<div class="setup-card mb-3"><div class="d-flex align-items-center mb-2"><b class="flex-grow-1">${bi('Set up your restaurant', 'ریسٹورنٹ سیٹ اپ کریں')}</b>
        <button class="btn btn-sm btn-link text-body-secondary btn-hide-setup">Hide</button></div>
        ${steps.map(([href, e, en, u, done], i) => `<a class="setup-step ${done ? 'done' : ''}" href="${href}"><span class="setup-n">${done ? '✓' : i + 1}</span><span class="fs-4">${e}</span><span class="flex-grow-1">${bi(en, u)}</span><i class="bi bi-chevron-right"></i></a>`).join('')}</div>` : ''}
      <div class="home-grid mb-3">
        ${tile('#/order', '➕', 'New order', 'نیا آرڈر', 'home-main', '', 'sale.create')}
        ${tile('#/orders', '🧾', 'Running orders', 'جاری آرڈر', 'home-orders', open.length)}
        ${tile('#/kitchen', '👨‍🍳', 'Kitchen', 'کچن', 'home-kitchen', readyNow ? `${readyNow} ready` : cookNow)}
        ${tile('#/expenses', '💸', 'Expenses', 'خرچے', 'home-exp', '', 'account.manage')}
        ${tile('#/products', '🍛', 'Menu', 'مینو', 'home-menu')}
        ${tile('#/reports', '📊', 'Reports', 'رپورٹ', 'home-rep', '', 'reports.view')}
        ${tile('#/staff', '🧑‍🍳', 'Staff', 'عملہ', 'home-staff', '', 'account.manage')}
      </div>
      <h2 class="h6 text-body-secondary">${bi('Today', 'آج')}</h2>
      <div class="row g-2 mb-3">
        ${stat('Sales', cur(f.sales), `${f.bills} bills${f.bills ? ` · avg ${fmtNum(f.sales / f.bills)}` : ''}`, '#/sales')}
        ${['dine', 'take', 'delivery'].map((k) => stat(`${T[k].emoji} ${T[k].label}`, cur(f.byType[k][0]), `${f.byType[k][1]} orders`, '#/reports/order-types')).join('')}
        ${Auth.can('account.manage') ? stat('Expenses', cur(f.expenses), f.salaries ? `+ salaries ${fmtNum(f.salaries)}` : '', '#/expenses') : ''}
        ${stat('Cash in hand', cur(cashIn), f.credit ? `khata today ${fmtNum(f.credit)}` : '', Auth.can('voucher.create') ? '#/vouchers' : null)}
      </div>
      <div class="row g-3">
        <div class="col-md-6"><h2 class="h6 text-body-secondary">${bi('Running orders', 'جاری آرڈر')}</h2><div class="list-card">${open.slice(0, 8).map((o) => `<a class="list-row" href="#/order/${encodeURIComponent(o.id)}">
          <div class="thumb fs-4">${T[o.type].emoji}</div><div class="main"><div class="title">${esc(o.type === 'dine' ? (o.tableName || 'No table') : (o.customerName || T[o.type].label))}</div><div class="sub">#${esc(Orders.shortNo(o.number))} · ${minsSince(o.createdAt)} · ${fmtQty(o.qtyTotal || 0)} items</div></div>
          <div class="end fw-semibold money">${fmtNum(o.total)}</div></a>`).join('') || UI.emptyState('No running orders', 'cup-hot')}</div></div>
        <div class="col-md-6"><h2 class="h6 text-body-secondary">${bi('Best sellers today', 'آج سب سے زیادہ بکنے والے')}</h2><div class="list-card">${f.top.map((x, i) => `<div class="list-row"><div class="thumb">${i + 1}</div><div class="main"><div class="title">${esc(x.name)}</div></div><div class="end"><b>${fmtQty(x.qty)}</b> <span class="small text-body-secondary">${fmtNum(x.amount)}</span></div></div>`).join('') || UI.emptyState('Nothing sold yet today', 'egg-fried')}</div>
          ${low.length ? `<h2 class="h6 text-body-secondary mt-3">${bi('Running low', 'اسٹاک کم ہے')}</h2><div class="list-card">${low.slice(0, 6).map((p) => `<a class="list-row" href="#/stock/${encodeURIComponent(p.id)}"><div class="main"><div class="title">${esc(p.name)}</div><div class="sub">alert below ${fmtQty(p.minStock || 0)}</div></div><div class="end"><span class="badge ${p.stock <= 0 ? 'text-bg-danger' : 'text-bg-warning'}">${fmtQty(p.stock)} ${esc(p.unit)}</span></div></a>`).join('')}</div>` : ''}
        </div>
      </div>`);
    if (Auth.can('backup.restore') && pref.get('legacyHandled') !== true) {
      Backup.legacyDataExists().then((yes) => yes && $el.find('.legacy-hint').html('<div class="alert alert-info py-2 small d-flex align-items-center gap-2"><i class="bi bi-database"></i><div class="flex-grow-1">Data from an older version was found on this device.</div><a class="btn btn-sm btn-info" href="#/backup">Review</a></div>'));
    }
    // Entrance animations only when the page is opened, not on live refreshes.
    if (!ctx.quiet) { UI.animateIn($el.find('.home-grid')); UI.countUp($el); }
    const tick = () => $el.find('.hero-clock').text(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    tick(); this._clock = setInterval(tick, 15000);
    $el.find('.btn-hide-setup').on('click', () => { pref.set('setupHidden', true); $el.find('.setup-card').remove(); });
    const refresh = () => { if (location.hash === '' || location.hash.startsWith('#/dashboard')) this.render(el, { quiet: true }); };
    this._h = refresh;
    document.addEventListener('data:changed', refresh);
  },
  destroy() { if (this._h) document.removeEventListener('data:changed', this._h); this._h = null; clearInterval(this._clock); },
};
