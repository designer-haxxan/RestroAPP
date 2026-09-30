// Stock: current stock, low stock, stock ledger per product, adjustments (in / out / count).
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, fmtDateTime, today, monthStart, uuid, num, round3, debounce, AppError } from '../core/utils.js';
import { money, dateFilter, bindDateFilter, pager } from '../core/views.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;
export const MOVE_LABELS = { opening: 'Opening stock', sale: 'Sale', purchase: 'Purchase', sale_return: 'Sale return', purchase_return: 'Purchase return', adjust: 'Adjustment', recipe: 'Used in orders' };
const moveLink = (m) => {
  const r = { sale: `#/sales/${m.refId}`, recipe: `#/sales/${m.refId}`, purchase: `#/purchases/${m.refId}`, sale_return: `#/returns/sale/${m.refId}`, purchase_return: `#/returns/purchase/${m.refId}`, adjust: `#/stock/adjustment/${m.refId}` }[m.type];
  return r ? `<a href="${esc(r)}">${esc(m.refNo)}</a>` : esc(m.refNo);
};

async function renderCurrent(el) {
  const $el = $(el);
  const canAdj = Auth.can('stock.adjust');
  $el.html(UI.pageHeader('Inventory', `${canAdj ? '<a class="btn btn-light btn-sm" href="#/stock/adjustments"><i class="bi bi-clock-history"></i><span class="d-none d-sm-inline"> Adjustments</span></a><a class="btn btn-primary btn-sm" href="#/stock/adjust"><i class="bi bi-sliders"></i> Adjust</a>' : ''}`) + `
    <div class="row g-2 mb-3 cards"></div>
    <div class="filters"><input type="search" class="form-control flex-grow-2 q" placeholder="Search products…">
      <select class="form-select f"><option value="all">All tracked</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="neg">Negative</option></select></div>
    <div class="list-card list"></div>`);
  const tracked = () => Catalog.allProducts().filter((p) => p.active && p.trackStock !== false);
  const all = tracked();
  const value = all.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePrice || 0), 0);
  const low = all.filter((p) => p.stock <= (p.minStock || 0)).length;
  $el.find('.cards').html([['Products', all.length], ['Stock value (cost)', money(value)], ['Low / out of stock', low]]
    .map(([l, v]) => `<div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">${l}</div><div class="fw-bold money">${v}</div></div></div></div>`).join(''));
  const draw = () => {
    const q = $el.find('.q').val(); const f = $el.find('.f').val();
    const ids = new Set(Catalog.searchProducts(q, { limit: Infinity }).map((p) => p.id));
    const list = tracked().filter((p) => ids.has(p.id) && (f === 'all' || (f === 'low' && p.stock <= (p.minStock || 0)) || (f === 'out' && p.stock <= 0) || (f === 'neg' && p.stock < 0)))
      .sort((a, b) => a.name.localeCompare(b.name));
    pager($el.find('.list'), list, (p) => `<a class="list-row" href="#/stock/${encodeURIComponent(p.id)}">
      <div class="main"><div class="title">${esc(p.name)}</div><div class="sub">Min ${fmtQty(p.minStock || 0)} · value ${fmtNum(Math.max(0, p.stock) * (p.purchasePrice || 0))}</div></div>
      <div class="end"><span class="badge fs-6 ${p.stock <= 0 ? 'text-bg-danger' : p.stock <= (p.minStock || 0) ? 'text-bg-warning' : 'text-bg-light border'}">${fmtQty(p.stock)} ${esc(p.unit)}</span></div></a>`,
    60, UI.emptyState('No products match', 'boxes'));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f', draw);
}

async function renderLedger(el, productId) {
  const $el = $(el);
  const p = Catalog.product(productId);
  if (!p) { $el.html(UI.pageHeader('Stock ledger', '', '#/stock') + UI.emptyState('Product not found', 'x-circle')); return; }
  let from = monthStart(); let to = today();
  $el.html(UI.pageHeader(p.name, Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-primary btn-sm" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-sliders"></i> Adjust</a>` : '', '#/stock') + `
    <div class="card stat-card mb-3"><div class="card-body"><div class="stat-label">Current stock</div><div class="stat-value">${p.trackStock === false ? 'Not tracked' : `${fmtQty(p.stock)} ${esc(p.unit)}`}</div></div></div>
    ${dateFilter(from, to)}<div class="card"><div class="card-body p-0 ledger"></div></div>`);
  const load = async () => {
    const [before, rows] = await idb.read(['stockMoves'], (t) => Promise.all([
      t.getAllByIndex('stockMoves', 'prodDate', IDBKeyRange.bound([productId, ''], [productId, from], false, true)),
      t.getAllByIndex('stockMoves', 'prodDate', IDBKeyRange.bound([productId, from], [productId, to])),
    ]));
    const opening = round3(before.reduce((s, m) => s + m.qty, 0));
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    let run = opening; let inQ = 0; let outQ = 0;
    const body = rows.map((m) => { run = round3(run + m.qty); if (m.qty > 0) inQ += m.qty; else outQ -= m.qty; return `<tr>
      <td class="text-nowrap">${fmtDate(m.date)}</td><td>${moveLink(m)}<div class="small text-body-secondary">${esc(MOVE_LABELS[m.type] || m.type)}${m.note && (m.type === 'adjust' || m.type === 'recipe') ? ' · ' + esc(m.note) : ''}</div></td>
      <td class="num text-success">${m.qty > 0 ? fmtQty(m.qty) : ''}</td><td class="num text-danger">${m.qty < 0 ? fmtQty(-m.qty) : ''}</td><td class="num fw-semibold">${fmtQty(run)}</td></tr>`; }).join('');
    $el.find('.ledger').html(`<div class="table-responsive"><table class="table table-sm table-report mb-0"><thead><tr><th>Date</th><th>Reference</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr></thead>
      <tbody><tr class="table-light"><td colspan="4">Opening</td><td class="num fw-semibold">${fmtQty(opening)}</td></tr>${body || '<tr><td colspan="5" class="text-center text-body-secondary py-3">No movements in this period</td></tr>'}</tbody>
      <tfoot><tr class="fw-semibold"><td colspan="2">Totals / closing</td><td class="num">${fmtQty(inQ)}</td><td class="num">${fmtQty(outQ)}</td><td class="num">${fmtQty(run)}</td></tr></tfoot></table></div>`);
  };
  bindDateFilter($el, (f, t) => { from = f; to = t; load(); });
  await load();
}

async function renderAdjust(el, productId) {
  Auth.require('stock.adjust');
  const $el = $(el);
  const lines = [];
  const id = uuid();
  const REASONS = ['Stock count correction', 'Wastage / spoiled', 'Staff meal', 'Damaged', 'Expired', 'Lost / theft', 'Found', 'Internal use', 'Stock in (other)', 'Other'];
  $el.html(UI.pageHeader('Stock adjustment', '', '#/stock') + `
    <div class="card mb-3"><div class="card-body">
      <div class="input-group mb-2"><input type="search" class="form-control q" placeholder="Search product to add…"><button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div>
      <div class="list-card results mb-2 d-none"></div>
      <div class="lines"></div>
      <div class="row g-2 mt-2">
        <div class="col-6"><label class="form-label">Reason</label><select class="form-select reason">${REASONS.map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div class="col-6"><label class="form-label">Date</label><input type="date" class="form-control date" value="${today()}" max="${today()}"></div>
        <div class="col-12"><label class="form-label">Note</label><input class="form-control note"></div>
      </div>
      <button class="btn btn-primary btn-lg w-100 mt-3 btn-save">Save adjustment</button>
    </div></div>`);
  const drawLines = () => {
    $el.find('.lines').html(lines.length ? `<div class="list-card">${lines.map((l, i) => {
      const p = Catalog.product(l.productId);
      const change = l.mode === 'set' ? round3(num(l.qty) - p.stock) : l.mode === 'out' ? -num(l.qty) : num(l.qty);
      return `<div class="list-row flex-wrap" data-i="${i}"><div class="main" style="min-width:140px"><div class="title">${esc(p.name)}</div><div class="sub">Current ${fmtQty(p.stock)} → <b>${fmtQty(p.stock + change)}</b> (${change >= 0 ? '+' : ''}${fmtQty(change)})</div></div>
        <select class="form-select form-select-sm mode" style="width:auto"><option value="in" ${l.mode === 'in' ? 'selected' : ''}>Add (+)</option><option value="out" ${l.mode === 'out' ? 'selected' : ''}>Remove (−)</option><option value="set" ${l.mode === 'set' ? 'selected' : ''}>Set count</option></select>
        <input class="form-control form-control-sm qty text-end" style="width:90px" inputmode="decimal" value="${esc(l.qty)}" placeholder="Qty">
        <button class="btn btn-sm btn-light rm" aria-label="Remove"><i class="bi bi-x-lg"></i></button></div>`;
    }).join('')}</div>` : UI.emptyState('Add products to adjust', 'sliders'));
  };
  const add = (p) => {
    if (!p) return;
    if (p.trackStock === false) return UI.toast('This product does not track stock', 'warning');
    if (!lines.some((l) => l.productId === p.id)) lines.push({ productId: p.id, mode: 'set', qty: '' });
    $el.find('.q').val(''); $el.find('.results').addClass('d-none'); drawLines();
    $el.find('.qty').last().trigger('focus');
  };
  drawLines();
  if (productId) add(Catalog.product(productId));
  let res = [];
  $el.on('input', '.q', debounce(() => {
    const q = $el.find('.q').val().trim();
    if (!q) return $el.find('.results').addClass('d-none');
    res = Catalog.searchProducts(q, { limit: 10 }).filter((p) => p.trackStock !== false);
    $el.find('.results').removeClass('d-none').html(res.map((p, i) => `<button class="list-row" data-r="${i}"><div class="main"><div class="title">${esc(p.name)}</div></div><div class="end">${fmtQty(p.stock)}</div></button>`).join('') || '<div class="p-2 small text-body-secondary">No match</div>');
  }, 150));
  $el.on('keydown', '.q', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(Catalog.findByCode($el.find('.q').val()) || res[0]); } });
  $el.on('click', '[data-r]', function () { add(res[+this.dataset.r]); });
  $el.on('click', '.btn-scan', async () => { const c = await Scanner.scan(); if (c) { const p = Catalog.findByCode(c); if (p) add(p); else UI.toast('No product for ' + c, 'warning'); } });
  $el.on('change', '.mode', function () { lines[+$(this).closest('[data-i]').data('i')].mode = this.value; drawLines(); });
  $el.on('input', '.qty', function () { lines[+$(this).closest('[data-i]').data('i')].qty = this.value; });
  $el.on('change', '.qty', drawLines);
  $el.on('click', '.rm', function () { lines.splice(+$(this).closest('[data-i]').data('i'), 1); drawLines(); });
  let busy = false;
  $el.on('click', '.btn-save', async function () {
    if (busy) return; busy = true; $(this).prop('disabled', true);
    try {
      const out = lines.map((l) => {
        const p = Catalog.product(l.productId);
        if (l.qty === '' || num(l.qty) < 0) throw new AppError(`Enter a valid quantity for ${p.name}.`);
        return { productId: l.productId, qty: l.mode === 'set' ? round3(num(l.qty) - p.stock) : l.mode === 'out' ? -num(l.qty) : num(l.qty) };
      });
      const { doc } = await Posting.saveAdjustment({ id, date: $el.find('.date').val(), reason: $el.find('.reason').val(), note: $el.find('.note').val(), lines: out });
      UI.toast(`${doc.number} saved`);
      location.hash = `#/stock/adjustment/${doc.id}`;
    } catch (e) { UI.toastError(e); } finally { busy = false; $(this).prop('disabled', false); }
  });
}

async function renderAdjustments(el) {
  const $el = $(el);
  let from = monthStart(); let to = today();
  $el.html(UI.pageHeader('Stock adjustments', '<a class="btn btn-primary btn-sm" href="#/stock/adjust"><i class="bi bi-plus-lg"></i> New</a>', '#/stock') + dateFilter(from, to) + '<div class="list-card list"></div>');
  const load = async () => {
    const list = (await idb.getAllByIndex('adjustments', 'date', IDBKeyRange.bound(from, to))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    pager($el.find('.list'), list, (a) => `<a class="list-row" href="#/stock/adjustment/${encodeURIComponent(a.id)}"><div class="main"><div class="title">${esc(a.number)} ${a.status === 'void' ? '<span class="badge text-bg-danger">Void</span>' : ''}</div><div class="sub">${fmtDate(a.date)} · ${esc(a.reason)} · ${a.items.length} product(s)</div></div></a>`, 50, UI.emptyState('No adjustments in this period', 'sliders'));
  };
  bindDateFilter($el, (f, t) => { from = f; to = t; load(); });
  await load();
}

async function renderAdjustment(el, id) {
  const $el = $(el).off();
  const a = await idb.get('adjustments', id);
  if (!a) { $el.html(UI.pageHeader('Adjustment', '', '#/stock/adjustments') + UI.emptyState('Not found', 'x-circle')); return; }
  $el.html(UI.pageHeader(a.number, a.status !== 'void' && Auth.can('stock.adjust') ? '<button class="btn btn-outline-danger btn-sm btn-void"><i class="bi bi-x-circle"></i> Void</button>' : '', '#/stock/adjustments') + `
    ${a.status === 'void' ? `<div class="alert alert-danger">Voided ${fmtDateTime(a.voidedAt)} by ${esc(a.voidedBy)}</div>` : ''}
    <div class="card"><div class="card-body"><div class="mb-2">${fmtDate(a.date)} · <b>${esc(a.reason)}</b>${a.note ? ' · ' + esc(a.note) : ''}</div>
    <table class="table table-sm table-report"><thead><tr><th>Product</th><th class="num">Before</th><th class="num">Change</th><th class="num">Value</th></tr></thead>
    <tbody>${a.items.map((i) => `<tr><td><a href="#/stock/${encodeURIComponent(i.productId)}">${esc(i.name)}</a></td><td class="num">${fmtQty(i.before)}</td><td class="num ${i.qty < 0 ? 'text-danger' : 'text-success'}">${i.qty > 0 ? '+' : ''}${fmtQty(i.qty)}</td><td class="num">${fmtNum(i.qty * i.cost)}</td></tr>`).join('')}</tbody></table>
    <div class="small text-body-secondary">By ${esc(a.userName)} · ${fmtDateTime(a.createdAt)}</div></div></div>`);
  $el.on('click', '.btn-void', async () => {
    if (!await UI.confirmDialog(`Void ${a.number}? Stock changes will be reversed.`, { okLabel: 'Void', okClass: 'btn-danger' })) return;
    try { await Posting.voidDocument('adjustment', id); UI.toast('Adjustment voided'); renderAdjustment(el, id); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el, { params }) {
    const [a, b] = params;
    if (!a) return renderCurrent(el);
    if (a === 'adjust') return renderAdjust(el, b);
    if (a === 'adjustments') return renderAdjustments(el);
    if (a === 'adjustment') return renderAdjustment(el, b);
    return renderLedger(el, a);
  },
};
