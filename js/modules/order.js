// Order taking. Built to be usable by anyone: big picture tiles, one tap adds an item, big coloured buttons.
//   #/order                      choose the kind of order (dine-in / takeaway / delivery)
//   #/order/dine                 choose a table
//   #/order/new/:type[/:tableId] new order
//   #/order/:id                  continue a running order
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, uuid, round2, round3, num, debounce, AppError } from '../core/utils.js';
import { getSettings, pref } from '../core/settings.js';
import { bi, ur, minsSince } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Orders from '../services/orders.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;
const cur = () => getSettings().currency;
const T = Orders.ORDER_TYPES;

let o = null; let $root = null; let cat = null; let saving = Promise.resolve(); let timer = null;

// ---------- start screens ----------
async function renderStart(el) {
  const open = await Orders.openOrders();
  const count = (t) => open.filter((x) => x.type === t).length;
  $(el).html(`<div class="start-wrap">
    <h1 class="start-title">${bi('New order', 'نیا آرڈر')}</h1>
    <div class="type-grid">
      ${Object.entries(T).map(([k, t]) => `<a class="type-card type-${t.color}" href="#/order/${k === 'dine' ? 'dine' : 'new/' + k}">
        <span class="type-emoji">${t.emoji}</span><span class="type-name">${bi(t.label, t.ur)}</span>
        ${count(k) ? `<span class="type-count">${count(k)} ${bi('running', 'جاری')}</span>` : ''}</a>`).join('')}
    </div>
    ${open.length ? `<a class="btn btn-light btn-lg w-100 mt-3 py-3" href="#/orders"><i class="bi bi-list-check me-2"></i>${bi(`Running orders (${open.length})`, 'جاری آرڈر')}</a>` : ''}
  </div>`);
  UI.animateIn($(el).find('.type-grid'));
}

export async function renderTables(el, { pickFor = null } = {}) {
  const [tables, open] = await Promise.all([Orders.allTables(), Orders.openOrders()]);
  const busy = new Map(open.filter((x) => x.type === 'dine' && x.tableId).map((x) => [x.tableId, x]));
  const areas = [...new Set(tables.map((t) => t.area || ''))];
  const tile = (t) => {
    const ord = busy.get(t.id);
    const href = ord ? `#/order/${encodeURIComponent(ord.id)}` : `#/order/new/dine/${encodeURIComponent(t.id)}`;
    return `<a class="table-tile ${ord ? 'busy k-' + ord.kitchen : 'free'}" href="${pickFor ? '#' : href}" data-id="${esc(t.id)}" data-busy="${ord ? 1 : 0}">
      <span class="table-name">${esc(t.name)}</span>
      ${ord ? `<span class="table-amt">${fmtNum(ord.total)}</span><span class="table-time"><i class="bi bi-clock"></i> ${minsSince(ord.createdAt)}</span>`
        : `<span class="table-free">${bi('Free', 'خالی')}</span>`}
    </a>`;
  };
  $(el).html(`${pickFor ? '' : UI.pageHeader('Choose table', '', '#/order')}
    ${tables.length ? areas.map((a) => `${a ? `<h2 class="h6 text-body-secondary mt-3">${esc(a)}</h2>` : ''}
      <div class="table-grid">${tables.filter((t) => (t.area || '') === a).map(tile).join('')}</div>`).join('')
      : `<div class="text-center py-4">${UI.emptyState('No tables yet.', 'grid-3x3')}${Auth.can('settings.manage') ? '<a class="btn btn-primary btn-lg" href="#/tables"><i class="bi bi-plus-lg me-1"></i>Add tables</a>' : ''}</div>`}
    ${pickFor ? '' : `<a class="btn btn-light btn-lg w-100 mt-4 py-3" href="#/order/new/dine"><i class="bi bi-person-standing me-2"></i>${bi('Dine-in without a table', 'بغیر ٹیبل کے')}</a>`}
    <div class="legend mt-3"><span class="lg free"></span>${bi('Free', 'خالی')} <span class="lg busy"></span>${bi('Occupied', 'مصروف')} <span class="lg k-ready"></span>${bi('Food ready', 'کھانا تیار')}</div>`);
  if (!pickFor) $(el).find('.table-grid').each((_, g) => UI.animateIn(g));
}

// ---------- order screen ----------
function layout() {
  return `<div class="order-screen">
    <section class="menu-side">
      <div class="menu-top">
        <div class="cat-bar"></div>
        <div class="menu-search"><i class="bi bi-search"></i><input type="search" class="form-control menu-q" placeholder="Search menu…" autocomplete="off"></div>
      </div>
      <div class="menu-grid"></div>
    </section>
    <section class="cart-side">
      <div class="cart-head"></div>
      <div class="cart-lines"></div>
      <div class="cart-foot">
        <div class="cart-totals"></div>
        <div class="cart-actions">
          <button class="btn act-btn act-kitchen btn-kitchen"><i class="bi bi-fire"></i>${bi('Kitchen', 'کچن')}<span class="badge unsent-badge"></span></button>
          <button class="btn act-btn act-bill btn-bill"><i class="bi bi-receipt"></i>${bi('Bill', 'بل')}</button>
          <button class="btn act-btn act-pay btn-pay"><i class="bi bi-cash-coin"></i>${bi('Pay', 'ادائیگی')}</button>
        </div>
      </div>
    </section>
    <button class="cart-bar"><span class="cart-bar-count"></span><span class="cart-bar-total"></span><span class="cart-bar-go">${bi('View order', 'آرڈر دیکھیں')} <i class="bi bi-chevron-up"></i></span></button>
  </div>`;
}

const menuItems = () => Catalog.searchProducts($root.find('.menu-q').val() || '', { kind: 'menu', categoryId: cat, limit: 500 });

function renderCats() {
  const menu = Catalog.allProducts().filter((p) => p.active && Catalog.kindOf(p) === 'menu');
  const cats = Catalog.allCategories().filter((c) => menu.some((p) => p.categoryId === c.id));
  if (cat && !cats.some((c) => c.id === cat)) cat = null;
  $root.find('.cat-bar').html(`<button class="cat-btn ${!cat ? 'active' : ''}" data-cat=""><span class="cat-emoji">⭐</span>${bi('All', 'سب')}</button>`
    + cats.map((c) => `<button class="cat-btn ${cat === c.id ? 'active' : ''}" data-cat="${esc(c.id)}"><span class="cat-emoji">${esc(c.emoji || '🍴')}</span>${bi(c.name, c.nameUr)}</button>`).join(''));
}

// Consistent pastel colour per item name, for items without a picture.
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function renderMenu() {
  const list = menuItems();
  const qty = new Map();
  for (const l of o.lines) qty.set(l.productId, round3((qty.get(l.productId) || 0) + l.qty));
  $root.find('.menu-grid').html(list.length ? list.map((p) => {
    const q = qty.get(p.id);
    return `<button class="dish ${q ? 'in-cart' : ''}" data-id="${esc(p.id)}" style="--h:${hue(p.name)}">
      ${p.image ? `<img class="dish-img" src="${p.image}" alt="" loading="lazy">` : `<span class="dish-img dish-ph">${esc(p.emoji || p.name.slice(0, 1).toUpperCase())}</span>`}
      <span class="dish-name">${esc(p.name)}</span>${ur(p.nameUr)}
      <span class="dish-price">${fmtNum(p.salePrice)}</span>
      ${q ? `<span class="dish-qty">${fmtQty(q)}</span>` : ''}
    </button>`;
  }).join('') : `<div class="menu-empty">${UI.emptyState('No menu items here yet.', 'egg-fried')}${Auth.can('product.edit') ? '<a class="btn btn-primary" href="#/products">Add menu items</a>' : ''}</div>`);
}

function headInfo() {
  const t = T[o.type];
  const who = o.type === 'dine' ? (o.tableName || 'No table') : (o.customerName || (o.type === 'delivery' ? 'Add customer details' : 'Walk-in'));
  return `<button class="btn btn-light btn-lg d-lg-none btn-close-cart" aria-label="Back to menu"><i class="bi bi-chevron-down"></i></button>
    <div class="cart-type type-${t.color}"><span>${t.emoji}</span></div>
    <button class="cart-who btn-details">
      <span class="who-main">${esc(who)}${o.guests ? ` <small>· ${o.guests} ${o.guests > 1 ? 'guests' : 'guest'}</small>` : ''}</span>
      <span class="who-sub">${o.number ? `#${esc(Orders.shortNo(o.number))} · ` : ''}${esc(t.label)}${o.type === 'delivery' && o.phone ? ' · ' + esc(o.phone) : ''}${o.waiterName ? ' · ' + esc(o.waiterName) : ''}${o.riderName ? ' · 🛵 ' + esc(o.riderName) : ''}</span>
    </button>
    <div class="dropdown"><button class="btn btn-light btn-lg" data-bs-toggle="dropdown" aria-label="More"><i class="bi bi-three-dots-vertical"></i></button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item btn-details"><i class="bi bi-pencil-square me-2"></i>Order details</button></li>
        ${o.type === 'dine' ? '<li><button class="dropdown-item btn-move"><i class="bi bi-arrow-left-right me-2"></i>Change table</button></li>' : ''}
        <li><button class="dropdown-item btn-note"><i class="bi bi-chat-left-text me-2"></i>Note for kitchen</button></li>
        <li><hr class="dropdown-divider"></li>
        <li><a class="dropdown-item" href="#/orders"><i class="bi bi-list-check me-2"></i>All running orders</a></li>
        <li><button class="dropdown-item text-danger btn-cancel-order"><i class="bi bi-x-octagon me-2"></i>Cancel order</button></li>
      </ul></div>`;
}

function renderCart() {
  $root.find('.cart-head').html(headInfo());
  const t0 = T[o.type];
  $('#topbar-title').text(`${t0.emoji} ${o.type === 'dine' ? (o.tableName || t0.label) : (o.customerName || t0.label)}${o.number ? ' · #' + Orders.shortNo(o.number) : ''}`);
  const lines = o.lines.filter((l) => l.qty > 0 || l.sent > 0);
  $root.find('.cart-lines').html(lines.length ? lines.map((l) => {
    const pending = round3(l.qty - (l.sent || 0));
    return `<div class="oline ${l.qty === 0 ? 'cancelled' : ''}" data-id="${esc(l.id)}">
      <button class="oline-info btn-line">
        <span class="oline-name">${esc(l.name)}</span>${ur(l.nameUr)}
        <span class="oline-meta">${fmtNum(l.rate)}${l.note ? ` · <i class="bi bi-chat-left-text"></i> ${esc(l.note)}` : ''}</span>
        ${l.sent ? `<span class="sent-tag ${pending < 0 ? 'text-danger' : ''}"><i class="bi bi-fire"></i> ${pending < 0 ? `${fmtQty(-pending)} to cancel` : `${fmtQty(l.sent)} in kitchen`}${pending > 0 ? ` · +${fmtQty(pending)} new` : ''}</span>` : ''}
      </button>
      <div class="stepper"><button class="st-dec" aria-label="Less">−</button><span class="st-qty">${fmtQty(l.qty)}</span><button class="st-inc" aria-label="More">+</button></div>
      <div class="oline-amt">${fmtNum(l.qty * l.rate)}</div>
    </div>`;
  }).join('') : `<div class="cart-empty"><div class="cart-empty-icon">👆</div>${bi('Tap food pictures to add them', 'کھانے کی تصویر پر ٹچ کریں')}</div>`);
  if (o.note) $root.find('.cart-lines').append(`<div class="order-note"><i class="bi bi-chat-left-text me-1"></i>${esc(o.note)}</div>`);
  const t = Orders.totals(o);
  const count = o.lines.reduce((s, l) => s + l.qty, 0);
  $root.find('.cart-totals').html(`
    ${t.discount || t.tax || t.charge ? `<div class="tot-row"><span>Subtotal</span><span>${fmtNum(t.subtotal)}</span></div>` : ''}
    ${t.discount ? `<div class="tot-row"><span>Discount</span><span>−${fmtNum(t.discount)}</span></div>` : ''}
    ${t.tax ? `<div class="tot-row"><span>Tax ${t.taxRate}%</span><span>${fmtNum(t.tax)}</span></div>` : ''}
    ${t.charge ? `<div class="tot-row"><span>${Orders.chargeLabel(o)}</span><span>${fmtNum(t.charge)}</span></div>` : ''}
    <div class="tot-grand"><span>${bi('Total', 'کل رقم')}</span><span class="money">${esc(cur())} ${fmtNum(t.total)}</span></div>`);
  const pending = o.lines.filter((l) => l.qty !== (l.sent || 0)).length;
  $root.find('.unsent-badge').text(pending || '').toggleClass('d-none', !pending);
  $root.find('.btn-kitchen').prop('disabled', !pending).toggleClass('pulse', pending > 0);
  $root.find('.btn-pay, .btn-bill').prop('disabled', !o.lines.some((l) => l.qty > 0));
  $root.find('.cart-bar-count').text(count ? `${fmtQty(count)} ${count === 1 ? 'item' : 'items'}` : 'No items');
  $root.find('.cart-bar-total').text(`${cur()} ${fmtNum(t.total)}`);
  $root.find('.cart-bar').toggleClass('has-items', count > 0);
}

function render() { renderCart(); renderMenu(); }

// ---------- saving ----------
function schedule() { clearTimeout(timer); timer = setTimeout(() => flush().catch(UI.toastError), 600); }
// Saves the order that is on screen now (also when called while leaving the screen).
function flush() {
  clearTimeout(timer);
  const ord = o;
  saving = saving.catch(() => {}).then(async () => {
    if (!ord || (!ord.number && !ord.lines.some((l) => l.qty > 0))) return;
    const saved = await Orders.saveOrder(ord);
    const first = !ord.number;
    ord.number = saved.number; ord.createdAt = saved.createdAt; ord.date = saved.date; ord.kitchen = saved.kitchen; ord.deliveryStatus = saved.deliveryStatus;
    const sent = new Map(saved.lines.map((l) => [l.id, l.sent]));
    for (const l of ord.lines) l.sent = sent.get(l.id) || 0;
    if (first && o === ord && $root) { history.replaceState(null, '', `#/order/${encodeURIComponent(ord.id)}`); renderCart(); }
  });
  return saving;
}

// ---------- cart operations ----------
function addItem(p, srcEl = null) {
  if (!p?.active) return;
  // The tapped picture flies into the order (side panel on big screens, bottom bar on phones).
  const side = $root.find('.cart-side')[0];
  UI.flyTo(srcEl?.querySelector('.dish-img'), side && side.offsetParent ? $root.find('.cart-lines')[0] : $root.find('.cart-bar')[0]);
  let l = o.lines.find((x) => x.productId === p.id && !x.note);
  if (!l) { l = Orders.lineFromProduct(p); o.lines.push(l); }
  l.qty = round3(l.qty + 1);
  UI.beep();
  render();
  const $d = $root.find(`.dish[data-id="${CSS.escape(p.id)}"]`).addClass('bump');
  $root.find(`.oline[data-id="${CSS.escape(l.id)}"]`).addClass('just-added');
  setTimeout(() => $d.removeClass('bump'), 250);
  schedule();
}

async function changeQty(id, delta) {
  const l = o.lines.find((x) => x.id === id);
  if (!l) return;
  const next = round3(l.qty + delta);
  if (next < 0) return;
  if (delta < 0 && next < (l.sent || 0) && !l._cancelOk) {
    if (!await UI.confirmDialog(`"${l.name}" is already in the kitchen. Cancel ${fmtQty(-delta)}? The kitchen will get a CANCEL ticket.`, { title: 'Cancel from kitchen?', okLabel: 'Yes, cancel it', okClass: 'btn-danger' })) return;
    l._cancelOk = true;
  }
  l.qty = next;
  if (l.qty === 0 && !l.sent) o.lines = o.lines.filter((x) => x !== l);
  render(); schedule();
}

async function editLine(id) {
  const l = o.lines.find((x) => x.id === id);
  if (!l) return;
  const notes = String(getSettings().restaurant.quickNotes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const canPrice = Auth.can('sale.edit');
  const r = await UI.formModal({
    title: l.name, submitLabel: 'Done',
    body: `<div class="big-qty mb-3"><button type="button" class="btn btn-light q-dec">−</button><input name="qty" class="form-control text-center" inputmode="decimal" value="${l.qty}"><button type="button" class="btn btn-light q-inc">+</button></div>
      <label class="form-label">Note for kitchen</label>
      <div class="note-chips mb-2">${notes.map((n) => `<button type="button" class="chip note-chip">${esc(n)}</button>`).join('')}</div>
      <input name="note" class="form-control form-control-lg mb-3" value="${esc(l.note)}" placeholder="e.g. less spicy">
      ${canPrice ? `<label class="form-label">Price</label><input name="rate" class="form-control mb-3" inputmode="decimal" value="${l.rate}">` : ''}
      ${l.sent ? '' : '<button type="button" class="btn btn-outline-danger w-100 btn-remove-line"><i class="bi bi-trash me-1"></i>Remove item</button>'}`,
    onShown: ($m) => {
      const $q = $m.find('[name=qty]');
      $m.find('.q-dec').on('click', () => $q.val(Math.max(0, round3(num($q.val()) - 1))));
      $m.find('.q-inc').on('click', () => $q.val(round3(num($q.val()) + 1)));
      $m.find('.note-chip').on('click', function () { const $n = $m.find('[name=note]'); const v = $n.val().trim(); $n.val(v ? `${v}, ${this.textContent}` : this.textContent); });
      $m.find('.btn-remove-line').on('click', () => { o.lines = o.lines.filter((x) => x !== l); render(); schedule(); $m.find('[data-bs-dismiss=modal]').first().trigger('click'); });
    },
    onSubmit: async (v) => {
      const qty = round3(num(v.qty));
      if (qty < 0) throw new AppError('Quantity cannot be negative.');
      if (qty < (l.sent || 0) && !await UI.confirmDialog(`Cancel ${fmtQty(l.sent - qty)} "${l.name}" already sent to the kitchen?`, { okLabel: 'Yes, cancel', okClass: 'btn-danger' })) return false;
      const rate = canPrice ? round2(num(v.rate)) : l.rate;
      if (rate < 0) throw new AppError('Price cannot be negative.');
      return { qty, rate, note: v.note.trim().slice(0, 120) };
    },
  });
  if (!r) return;
  // Items already in the kitchen keep their ticket; a changed note only applies to the extra (new) quantity.
  if (l.sent && r.note !== l.note) {
    const extra = round3(r.qty - l.sent);
    Object.assign(l, { qty: Math.min(r.qty, l.sent), rate: r.rate });
    if (extra > 0) o.lines.push({ ...l, id: uuid(), qty: extra, sent: 0, note: r.note });
    else UI.toast('This item is already in the kitchen, so the note was not added. Tell the cook, or add one more with the note.', 'warning', 6000);
  } else Object.assign(l, r);
  if (l.qty === 0 && !l.sent) o.lines = o.lines.filter((x) => x !== l);
  render(); schedule();
}

// ---------- details (table, guests, waiter, customer, delivery) ----------
async function editDetails() {
  const staff = (await Orders.allStaff()).filter((s) => s.active);
  const waiters = staff.filter((s) => ['waiter', 'manager', 'cashier'].includes(s.role));
  const riders = staff.filter((s) => s.role === 'rider');
  const isDel = o.type === 'delivery';
  let customerId = o.customerId;
  const r = await UI.formModal({
    title: `${T[o.type].emoji} ${T[o.type].label} details`, submitLabel: 'Save',
    body: `<div class="btn-group w-100 mb-3" role="group">${Object.entries(T).map(([k, t]) => `<input type="radio" class="btn-check" name="type" id="ot-${k}" value="${k}" ${o.type === k ? 'checked' : ''}><label class="btn btn-outline-secondary py-2" for="ot-${k}">${t.emoji} ${t.label}</label>`).join('')}</div>
      <div class="row g-2">
        <div class="col-6 f-dine"><label class="form-label">Guests</label><input name="guests" class="form-control form-control-lg" inputmode="numeric" value="${o.guests || ''}"></div>
        <div class="col-6 f-dine"><label class="form-label">Waiter</label><select name="waiterId" class="form-select form-select-lg"><option value="">—</option>${UI.options(waiters, o.waiterId)}</select></div>
        <div class="col-12"><label class="form-label">Phone</label><input name="phone" class="form-control form-control-lg" inputmode="tel" value="${esc(o.phone)}" placeholder="03xx-xxxxxxx"><div class="list-group phone-hits mt-1"></div></div>
        <div class="col-12"><label class="form-label">Customer name</label><input name="customerName" class="form-control form-control-lg" value="${esc(o.customerName)}"></div>
        <div class="col-12 f-del"><label class="form-label">Address</label><textarea name="address" class="form-control" rows="2">${esc(o.address)}</textarea></div>
        <div class="col-6 f-del"><label class="form-label">Rider</label><select name="riderId" class="form-select form-select-lg"><option value="">—</option>${UI.options(riders, o.riderId)}</select></div>
        <div class="col-6 f-del"><label class="form-label">Delivery charge</label><input name="charge" class="form-control form-control-lg" inputmode="decimal" value="${o.charge ?? getSettings().restaurant.deliveryCharge ?? 0}"></div>
      </div>
      <div class="form-text cust-linked">${customerId ? '<i class="bi bi-person-check text-success"></i> Saved customer (can pay later / khata)' : ''}</div>`,
    onShown: ($m) => {
      const sync = () => { const t = $m.find('[name=type]:checked').val(); $m.find('.f-dine').toggleClass('d-none', t !== 'dine'); $m.find('.f-del').toggleClass('d-none', t !== 'delivery'); };
      $m.on('change', '[name=type]', sync); sync();
      $m.on('input', '[name=phone]', debounce(function () {
        const q = String($m.find('[name=phone]').val()).replace(/\D/g, '');
        const hits = q.length >= 4 ? Catalog.allParties('customers').filter((c) => c.active && String(c.phone || '').replace(/\D/g, '').includes(q)).slice(0, 5) : [];
        $m.find('.phone-hits').html(hits.map((c) => `<button type="button" class="list-group-item list-group-item-action" data-id="${esc(c.id)}"><b>${esc(c.name)}</b> · ${esc(c.phone)}<div class="small text-body-secondary">${esc(c.address || '')}</div></button>`).join(''));
      }, 200));
      $m.on('click', '.phone-hits [data-id]', function () {
        const c = Catalog.party('customers', this.dataset.id);
        customerId = c.id;
        $m.find('[name=phone]').val(c.phone); $m.find('[name=customerName]').val(c.name); $m.find('[name=address]').val(c.address || '');
        $m.find('.phone-hits').empty(); $m.find('.cust-linked').html('<i class="bi bi-person-check text-success"></i> Saved customer (can pay later / khata)');
      });
      $m.find(isDel ? '[name=phone]' : o.type === 'dine' ? '[name=guests]' : '[name=customerName]').trigger('focus');
    },
    onSubmit: async (v) => {
      const type = v.type;
      if (type !== 'dine' && o.tableId) { o.tableId = ''; o.tableName = ''; }
      const phone = v.phone.trim(); const name = v.customerName.trim();
      if (customerId && Catalog.party('customers', customerId)?.phone !== phone && phone) customerId = null;
      // Delivery customers are remembered, so next time typing the phone number fills everything in.
      if (!customerId && phone && name && type === 'delivery' && Auth.can('party.edit')) {
        const same = Catalog.allParties('customers').find((c) => c.active && String(c.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''));
        customerId = same ? same.id : (await Posting.saveParty('customers', { name, phone, address: v.address })).id;
      }
      const w = waiters.find((s) => s.id === v.waiterId); const rd = riders.find((s) => s.id === v.riderId);
      return { type, guests: parseInt(v.guests, 10) || 0, waiterId: w?.id || '', waiterName: w?.name || '', phone, customerName: name, customerId: customerId || null,
        address: type === 'delivery' ? v.address.trim() : '', riderId: rd?.id || '', riderName: rd?.name || '',
        charge: type === 'delivery' ? round2(num(v.charge)) : null };
    },
  });
  if (!r) return;
  Object.assign(o, r);
  renderCart();
  if (o.number) await flush();
}

async function moveTable() {
  const [tables, open] = await Promise.all([Orders.allTables(), Orders.openOrders()]);
  const busy = new Set(open.filter((x) => x.id !== o.id && x.tableId).map((x) => x.tableId));
  const picked = await UI.pick({ title: 'Move to table', search: async (q) => tables.filter((t) => !busy.has(t.id) && t.name.toLowerCase().includes(q.toLowerCase()))
    .map((t) => ({ id: t.id, title: t.name, subtitle: t.area || '', right: t.id === o.tableId ? 'current' : '' })) });
  if (!picked) return;
  Object.assign(o, { tableId: picked.id, tableName: picked.title, type: 'dine' });
  renderCart();
  if (o.number) { try { await flush(); UI.toast(`Moved to ${picked.title}`); } catch (e) { UI.toastError(e); } }
}

// ---------- kitchen / bill / pay ----------
let sending = false;
async function sendKitchen({ quiet = false } = {}) {
  if (!Orders.unsent(o)) return true;
  if (sending) return false; // double tap
  sending = true;
  $root?.find('.btn-kitchen').prop('disabled', true);
  try {
    await flush();
    const { order, kots } = await Orders.sendToKitchen(o);
    o = { ...order };
    render();
    if (kots.length) {
      if (!quiet) UI.toast(`Sent to kitchen — KOT #${kots.map((k) => Orders.shortNo(k.number)).join(', #')}`);
      if (getSettings().printer.kotPrint) await Printer.printKots(kots);
    }
    return true;
  } catch (e) { UI.toastError(e); return false; } finally { sending = false; if ($root && o) renderCart(); }
}

async function printBill() {
  await flush();
  await Printer.printOrderBill(o, Orders.totals(o));
}

async function payDialog() {
  if (!o.lines.some((l) => l.qty > 0)) return;
  const accounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active)
    .sort((a, b) => (a.id === 'cash' ? -1 : b.id === 'cash' ? 1 : a.name.localeCompare(b.name)));
  const saleId = uuid();
  let method = pref.get('payAccount', 'cash');
  if (!accounts.some((a) => a.id === method)) method = 'cash';
  let received = null; // null = exact amount
  const m = UI.modal({
    title: 'Payment', static: true, size: 'md',
    body: `<div class="pay-total-box"><div class="pay-label">${bi('Amount to pay', 'کل رقم')}</div><div class="pay-total money"></div><div class="pay-break small"></div></div>
      <div class="pay-methods">${accounts.map((a) => `<button type="button" class="pay-method" data-m="${esc(a.id)}"><i class="bi bi-${a.type === 'cash' ? 'cash-stack' : 'credit-card-2-front'}"></i>${esc(a.name)}</button>`).join('')}
        ${o.customerId ? `<button type="button" class="pay-method" data-m="credit"><i class="bi bi-journal-text"></i>${bi('Pay later', 'ادھار / کھاتہ')}</button>` : ''}</div>
      <div class="pay-cash">
        <label class="form-label mt-2">${bi('Cash received', 'وصول رقم')}</label>
        <input class="form-control form-control-lg pay-in money text-center" inputmode="decimal" placeholder="0">
        <div class="pay-quick"></div>
        <div class="pay-change"></div>
      </div>
      <details class="pay-more mt-2"><summary>Discount${o.type === 'delivery' ? ' / delivery charge' : ''}</summary>
        <div class="row g-2 mt-1">
          <div class="col-6"><label class="form-label">Discount (${esc(cur())})</label><input class="form-control pay-disc" inputmode="decimal" value="${o.discount || ''}" placeholder="0"></div>
          <div class="col-6"><label class="form-label">Discount %</label><input class="form-control pay-pct" inputmode="decimal" placeholder="%"></div>
          ${o.type !== 'take' ? `<div class="col-12"><label class="form-label">${Orders.chargeLabel(o)}</label><input class="form-control pay-charge" inputmode="decimal" value="${Orders.totals(o).charge}"></div>` : ''}
        </div></details>
      <div class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" id="pay-print" ${getSettings().printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="pay-print">Print receipt</label></div>
      <div class="alert alert-danger py-2 small d-none pay-error mt-2 mb-0"></div>`,
    footer: `<button class="btn btn-light btn-lg" data-bs-dismiss="modal">Back</button><button class="btn btn-success btn-lg flex-grow-1 pay-done"><i class="bi bi-check2-circle me-1"></i>${bi('Done', 'مکمل')}</button>`,
  });
  const $m = m.$el;
  const tot = () => Orders.totals(o);
  const update = () => {
    const t = tot();
    $m.find('.pay-total').text(`${cur()} ${fmtNum(t.total)}`);
    $m.find('.pay-break').text([t.discount ? `Discount ${fmtNum(t.discount)}` : '', t.tax ? `Tax ${fmtNum(t.tax)}` : '', t.charge ? `${Orders.chargeLabel(o)} ${fmtNum(t.charge)}` : ''].filter(Boolean).join(' · '));
    $m.find('.pay-method').removeClass('active').filter(`[data-m="${CSS.escape(method)}"]`).addClass('active');
    const credit = method === 'credit';
    const isCash = accounts.find((a) => a.id === method)?.type === 'cash';
    $m.find('.pay-cash').toggleClass('d-none', credit || !isCash);
    const quick = [t.total];
    [100, 500, 1000, 5000].forEach((u) => { const v = Math.ceil(t.total / u) * u; if (v > t.total && !quick.includes(v) && quick.length < 5) quick.push(v); });
    $m.find('.pay-quick').html(quick.map((v, i) => `<button type="button" class="btn btn-outline-success" data-v="${v}">${i === 0 ? 'Exact' : fmtNum(v)}</button>`).join(''));
    const got = received === null ? t.total : received;
    if (received === null) $m.find('.pay-in').val(t.total);
    const change = round2(got - t.total);
    $m.find('.pay-change').html(credit ? '' : change >= 0
      ? `<div class="change-box ok">${bi('Give back', 'واپس کریں')}<b class="money">${esc(cur())} ${fmtNum(change)}</b></div>`
      : `<div class="change-box short">${bi('Short by', 'کم ہیں')}<b class="money">${esc(cur())} ${fmtNum(-change)}</b></div>`);
    $m.find('.pay-done').prop('disabled', !credit && isCash && change < 0);
  };
  $m.on('click', '.pay-method', function () { method = this.dataset.m; update(); });
  $m.on('input', '.pay-in', function () { received = num(this.value); update(); });
  $m.on('focus', '.pay-in', function () { this.select(); });
  $m.on('click', '.pay-quick [data-v]', function () { received = num(this.dataset.v); $m.find('.pay-in').val(received); update(); });
  $m.on('input', '.pay-disc', function () { o.discount = Math.max(0, num(this.value)); $m.find('.pay-pct').val(''); update(); });
  $m.on('input', '.pay-pct', function () {
    const pct = Math.min(100, Math.max(0, num(this.value)));
    const sub = Posting.previewDoc(o.lines.filter((l) => l.qty > 0), 0, 0)?.subtotal || 0;
    o.discount = Math.round(sub * pct / 100); $m.find('.pay-disc').val(o.discount || ''); update();
  });
  $m.on('input', '.pay-charge', function () { o.charge = Math.max(0, num(this.value)); update(); });
  let busy = false;
  $m.find('.pay-done').on('click', async function () {
    if (busy) return; busy = true;
    const $b = $(this).prop('disabled', true);
    $m.find('.pay-error').addClass('d-none');
    try {
      const t = tot();
      const credit = method === 'credit';
      const acc = credit ? 'cash' : method;
      if (!credit) pref.set('payAccount', method);
      const isCash = accounts.find((a) => a.id === acc)?.type === 'cash';
      const tendered = credit ? 0 : isCash ? (received === null ? t.total : received) : t.total;
      if (!(await sendKitchen({ quiet: true }))) throw new AppError('Could not send the order to the kitchen.');
      await flush();
      const { doc } = await Posting.saveSale({
        id: saleId, items: o.lines.filter((l) => l.qty > 0).map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, rate: l.rate, discount: 0, note: l.note })),
        discount: t.discount, taxRate: Orders.taxRate(), charge: t.charge, chargeLabel: Orders.chargeLabel(o), tendered, paymentAccountId: acc,
        customerId: o.customerId || null, customerName: o.customerName || '', orderId: o.id,
      });
      const doPrint = $m.find('#pay-print').prop('checked');
      if (o.type !== 'take') Orders.closeTickets(o.id).catch(console.warn);
      m.close();
      await m.closed;
      o = null;
      if (doPrint) Printer.printDocument('sale', doc, { silentFail: true });
      done(doc);
    } catch (e) {
      console.warn(e);
      $m.find('.pay-error').text(e.message || String(e)).removeClass('d-none');
      $b.prop('disabled', false);
    } finally { busy = false; }
  });
  update();
  m.closed.then(() => { if (o) { renderCart(); schedule(); } });
}

function done(doc) {
  const m = UI.modal({
    title: doc.balance > 0 ? 'Saved' : 'Paid', fullscreenMobile: false, scrollable: false, static: true,
    body: `<div class="text-center py-2"><div class="done-tick">✓</div>
      <div class="h4 mt-2 mb-1">${doc.paid > 0 ? bi('Payment received', 'ادائیگی ہو گئی') : bi('Bill saved on khata', 'بل کھاتے میں لکھ دیا')}</div>
      <div class="text-body-secondary">${esc(doc.number)} · ${esc(cur())} ${fmtNum(doc.total)}</div>
      ${doc.change ? `<div class="change-box ok mt-3">${bi('Give back', 'واپس کریں')}<b class="money">${esc(cur())} ${fmtNum(doc.change)}</b></div>` : ''}
      ${doc.balance ? `<div class="alert alert-warning mt-3 mb-0">Added to ${esc(doc.customerName)}'s khata: <b>${esc(cur())} ${fmtNum(doc.balance)}</b></div>` : ''}</div>`,
    footer: `<button class="btn btn-outline-secondary btn-lg btn-reprint"><i class="bi bi-printer"></i></button>
      <a class="btn btn-light btn-lg" href="#/orders">${bi('Orders', 'آرڈرز')}</a>
      <a class="btn btn-primary btn-lg flex-grow-1" href="#/order">${bi('New order', 'نیا آرڈر')}</a>`,
  });
  UI.confetti();
  m.$el.find('.btn-reprint').on('click', () => Printer.printDocument('sale', doc));
  m.$el.find('a').on('click', () => m.close());
  // Closed with ✕: leave the paid order's screen.
  m.closed.then(() => { if (location.hash.startsWith('#/order/')) location.hash = '#/order'; });
}

async function cancelOrder() {
  const sent = o.lines.some((l) => l.sent > 0);
  if (!o.number || (!sent && !o.lines.some((l) => l.qty > 0))) {
    const id = o.id; o = null;
    if (id) await Orders.discardIfEmpty(id).catch(() => {});
    location.hash = '#/orders'; return;
  }
  const reason = await UI.formModal({ title: `Cancel order #${Orders.shortNo(o.number)}`, submitLabel: 'Cancel order', submitClass: 'btn-danger',
    body: `<p>${sent ? 'Food already sent to the kitchen will get a CANCEL ticket.' : 'The order will be cancelled.'} Cancelled orders stay in the records.</p>
      <label class="form-label">Reason</label><input name="reason" class="form-control form-control-lg" placeholder="Customer left, wrong order…">`,
    onSubmit: (v) => v.reason.trim() || 'No reason' });
  if (!reason) return;
  try {
    await flush();
    const { kots } = await Orders.cancelOrder(o.id, reason);
    o = null;
    if (kots.length && getSettings().printer.kotPrint) await Printer.printKots(kots);
    UI.toast('Order cancelled', 'warning');
    location.hash = '#/orders';
  } catch (e) { UI.toastError(e); }
}

async function editNote() {
  const note = await UI.formModal({ title: 'Note for the whole order', body: `<textarea name="note" class="form-control form-control-lg" rows="3" placeholder="e.g. guests in a hurry">${esc(o.note)}</textarea>`, onSubmit: (v) => ({ note: v.note.trim() }) });
  if (!note) return;
  o.note = note.note; renderCart(); schedule();
}

// ---------- module ----------
async function openOrder(el, params) {
  if (params[0] === 'new') {
    const type = T[params[1]] ? params[1] : 'take';
    o = Orders.newOrder(type);
    if (type === 'dine' && params[2]) {
      const [tb, open] = await Promise.all([idb.get('tables', params[2]), Orders.openOrders()]);
      const running = open.find((x) => x.tableId === params[2]);
      if (running) { location.replace(`#/order/${encodeURIComponent(running.id)}`); return; }
      if (tb) Object.assign(o, { tableId: tb.id, tableName: tb.name });
    }
  } else {
    const found = await idb.get('orders', params[0]);
    if (!found) throw new AppError('Order not found.');
    if (found.status !== 'open') { location.replace(found.saleId ? `#/sales/${encodeURIComponent(found.saleId)}` : '#/orders'); return; }
    o = found;
  }
  $root = $(el);
  $root.html(layout());
  renderCats(); render();
  UI.animateIn($root.find('.menu-grid')); UI.animateIn($root.find('.cat-bar'));

  $root.on('click', '.cat-btn', function () { cat = this.dataset.cat || null; renderCats(); renderMenu(); $root.find('.menu-grid').scrollTop(0); UI.animateIn($root.find('.menu-grid')); });
  $root.on('input', '.menu-q', debounce(renderMenu, 120));
  $root.on('click', '.dish', function () { addItem(Catalog.product(this.dataset.id), this); });
  $root.on('click', '.st-inc, .st-dec', function () { changeQty($(this).closest('.oline').data('id'), $(this).hasClass('st-inc') ? 1 : -1); });
  $root.on('click', '.btn-line', function () { editLine($(this).closest('.oline').data('id')); });
  $root.on('click', '.btn-details', editDetails);
  $root.on('click', '.btn-move', moveTable);
  $root.on('click', '.btn-note', editNote);
  $root.on('click', '.btn-cancel-order', cancelOrder);
  $root.on('click', '.btn-kitchen', () => sendKitchen());
  $root.on('click', '.btn-bill', printBill);
  $root.on('click', '.btn-pay', payDialog);
  $root.on('click', '.cart-bar', () => $root.find('.order-screen').addClass('show-cart'));
  $root.on('click', '.btn-close-cart', () => $root.find('.order-screen').removeClass('show-cart'));
  if (params[0] === 'new' && o.type === 'delivery') setTimeout(editDetails, 150);
  if (params[1] === 'pay') { history.replaceState(null, '', `#/order/${encodeURIComponent(o.id)}`); setTimeout(payDialog, 50); }
}

export default {
  async render(el, { params }) {
    cat = null;
    if (!params.length) return renderStart(el);
    if (params[0] === 'dine') return renderTables(el);
    return openOrder(el, params);
  },
  destroy() {
    clearTimeout(timer);
    const cur0 = o;
    if (cur0) {
      // Save what is on screen; drop orders that never got an item.
      flush().catch(UI.toastError).finally(() => { if (!cur0.lines.some((l) => l.qty > 0 || l.sent > 0)) Orders.discardIfEmpty(cur0.id).catch(() => {}); });
    }
    o = null;
    $root?.off(); $root = null;
  },
};

