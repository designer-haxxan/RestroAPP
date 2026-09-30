// Restaurant operations: dining tables, running orders, kitchen order tickets (KOT) and staff.
// An order is "open" while guests are eating / food is being prepared. It is closed by its bill (Posting.saveSale
// with orderId), which marks the order paid in the same transaction. Orders themselves have no accounting effect.
import * as idb from '../db/idb.js';
import { uuid, round2, round3, num, nowISO, today, AppError, clean, lc } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';
import { nextNumber, previewDoc, notifyChanged } from './posting.js';

export const ORDER_TYPES = {
  dine: { label: 'Dine-in', ur: 'ہال / ٹیبل', icon: 'cup-hot', emoji: '🍽️', color: 'dine' },
  take: { label: 'Takeaway', ur: 'پارسل', icon: 'bag', emoji: '🛍️', color: 'take' },
  delivery: { label: 'Delivery', ur: 'ہوم ڈیلیوری', icon: 'scooter', emoji: '🛵', color: 'delivery' },
};
export const KOT_STATUS = {
  new: { label: 'New', ur: 'نیا', color: 'danger' },
  preparing: { label: 'Cooking', ur: 'تیار ہو رہا ہے', color: 'warning' },
  ready: { label: 'Ready', ur: 'تیار', color: 'success' },
  served: { label: 'Served', ur: 'پیش کر دیا', color: 'secondary' },
  cancelled: { label: 'Cancelled', ur: 'منسوخ', color: 'secondary' },
};
export const DELIVERY_STATUS = {
  pending: { label: 'Not sent', ur: 'ابھی نہیں بھیجا' },
  on_way: { label: 'On the way', ur: 'راستے میں' },
  delivered: { label: 'Delivered', ur: 'پہنچ گیا' },
};
export const STAFF_ROLES = {
  waiter: ['Waiter', 'ویٹر', '🧑‍🍳'], chef: ['Cook / Chef', 'باورچی', '👨‍🍳'], rider: ['Delivery rider', 'رائیڈر', '🛵'],
  cashier: ['Cashier', 'کیشیئر', '💵'], helper: ['Helper', 'ہیلپر', '🧽'], cleaner: ['Cleaner', 'صفائی', '🧹'],
  guard: ['Guard', 'چوکیدار', '💂'], manager: ['Manager', 'منیجر', '🧑‍💼'],
};

// Short display number: "ORD-000123" -> "123".
export const shortNo = (number) => String(number || '').replace(/^.*?-0*(?=\d)/, '');
export const stations = () => {
  const list = String(getSettings().restaurant.stations || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['Kitchen'];
};

// ---------- totals ----------
export function chargeOf(o, subtotal, discount) {
  if (o.charge !== null && o.charge !== undefined && o.charge !== '') return round2(num(o.charge));
  const r = getSettings().restaurant;
  if (o.type === 'delivery') return round2(num(r.deliveryCharge));
  // Whole rupees: nobody gives change in paisa.
  if (o.type === 'dine' && num(r.serviceCharge) > 0) return Math.round((subtotal - discount) * num(r.serviceCharge) / 100);
  return 0;
}
export const chargeLabel = (o) => (o.type === 'delivery' ? 'Delivery charges' : 'Service charges');
export function taxRate() { const s = getSettings(); return s.taxEnabled ? num(s.taxRate) : 0; }

export function totals(o) {
  const lines = o.lines.filter((l) => l.qty > 0);
  const base = previewDoc(lines, 0, 0) || { subtotal: 0 };
  const discount = Math.min(round2(num(o.discount)), base.subtotal);
  const charge = lines.length ? chargeOf(o, base.subtotal, discount) : 0;
  return previewDoc(lines, discount, taxRate(), charge) || { subtotal: 0, discount: 0, tax: 0, charge: 0, total: 0, qtyTotal: 0, lines: [] };
}
export const unsent = (o) => o.lines.some((l) => l.qty !== (l.sent || 0));

// ---------- orders ----------
export function newOrder(type, extra = {}) {
  return { id: uuid(), number: '', type, status: 'open', lines: [], discount: 0, charge: null, note: '', guests: 0,
    tableId: '', tableName: '', waiterId: '', waiterName: '', customerId: null, customerName: '', phone: '', address: '',
    riderId: '', riderName: '', deliveryStatus: 'pending', kitchen: 'none', ...extra };
}

function summarize(o) {
  const t = totals(o);
  o.total = t.total; o.itemCount = o.lines.filter((l) => l.qty > 0).length; o.qtyTotal = t.qtyTotal;
  return o;
}

// Creates or updates an open order. The number is assigned on first save.
// What was sent to the kitchen, the kitchen state and (unless options.delivery) the delivery state are owned by the
// database: a stale copy on screen (double tap, second window) can never undo them or cause a duplicate ticket.
export async function saveOrder(order, options = {}) {
  Auth.require('sale.create');
  const now = nowISO();
  const saved = await idb.write(['orders', 'meta', 'tables'], async (t) => {
    const old = await t.get('orders', order.id);
    if (old && old.status !== 'open') throw new AppError(`Order ${old.number} is already ${old.status}.`);
    if (order.type === 'dine' && order.tableId) {
      const busy = (await t.getAllByIndex('orders', 'status', 'open')).find((x) => x.tableId === order.tableId && x.id !== order.id);
      if (busy) throw new AppError(`${order.tableName || 'This table'} already has order #${shortNo(busy.number)}.`);
    }
    const o = { ...order, status: 'open', updatedAt: now };
    o.lines = order.lines.map(({ _cancelOk, ...l }) => ({ ...l, qty: round3(num(l.qty)), sent: 0 }));
    if (!old) { o.number = await nextNumber(t, 'order'); o.createdAt = now; o.date = today(); o.kitchen = 'none'; const u = Auth.user(); o.userName = u?.name || ''; }
    else {
      o.number = old.number; o.createdAt = old.createdAt; o.date = old.date; o.kitchen = old.kitchen; o.userName = old.userName;
      if (!options.delivery) o.deliveryStatus = old.deliveryStatus;
      const sent = new Map(old.lines.map((l) => [l.id, l.sent || 0]));
      for (const l of o.lines) l.sent = sent.get(l.id) || 0;
      // A line the kitchen already has can't just disappear: keep it at 0 so the next send cancels it.
      for (const l of old.lines) if (l.sent > 0 && !o.lines.some((x) => x.id === l.id)) o.lines.push({ ...l, qty: 0 });
    }
    o.customerName = clean(o.customerName, 120); o.phone = clean(o.phone, 40); o.address = clean(o.address, 300); o.note = clean(o.note, 300);
    summarize(o);
    await t.put('orders', o);
    return o;
  });
  notifyChanged();
  return saved;
}

// Removes an order that never had anything sent to the kitchen and has no items.
export async function discardIfEmpty(id) {
  const r = await idb.write(['orders'], async (t) => {
    const o = await t.get('orders', id);
    if (!o || o.status !== 'open' || o.lines.some((l) => l.qty > 0 || l.sent > 0)) return false;
    await t.delete('orders', id);
    return true;
  });
  if (r) notifyChanged();
  return r;
}

export async function cancelOrder(id, reason = '') {
  Auth.require('sale.create');
  const res = await idb.write(['orders', 'kots', 'meta'], async (t) => {
    const o = await t.get('orders', id);
    if (!o) throw new AppError('Order not found.');
    if (o.status !== 'open') throw new AppError(`Order ${o.number} is already ${o.status}.`);
    const sentLines = o.lines.filter((l) => l.sent > 0);
    let cancelKots = [];
    if (sentLines.length) {
      // Tell the kitchen to stop: one CANCEL ticket per station for everything already sent.
      cancelKots = await makeKots(t, o, sentLines.map((l) => ({ ...l, diff: -l.sent })), true);
      for (const k of await t.getAllByIndex('kots', 'orderId', id)) {
        if (['new', 'preparing'].includes(k.status) && !cancelKots.some((c) => c.id === k.id)) { k.status = 'cancelled'; k.updatedAt = nowISO(); await t.put('kots', k); }
      }
    }
    Object.assign(o, { status: 'cancelled', cancelReason: clean(reason, 200), cancelledAt: nowISO(), cancelledBy: Auth.user()?.name || '', updatedAt: nowISO() });
    await t.put('orders', o);
    return { order: o, kots: cancelKots };
  });
  notifyChanged();
  return res;
}

async function makeKots(t, o, diffs, isCancel = false) {
  const byStation = new Map();
  for (const l of diffs) {
    const st = l.station || 'Kitchen';
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st).push({ name: l.name, nameUr: l.nameUr || '', qty: round3(Math.abs(l.diff)), note: l.note || '', cancel: l.diff < 0 });
  }
  const out = [];
  const now = nowISO();
  for (const [station, items] of byStation) {
    const k = { id: uuid(), number: await nextNumber(t, 'kot'), orderId: o.id, orderNo: o.number, type: o.type, tableName: o.tableName || '',
      customerName: o.customerName || '', waiterName: o.waiterName || '', station, items, note: o.note || '',
      // Cancel tickets also start as "new" so the kitchen sees them; the cook acknowledges them with OK.
      status: 'new', cancelTicket: isCancel || items.every((i) => i.cancel),
      date: today(), createdAt: now, updatedAt: now, userName: Auth.user()?.name || '' };
    await t.add('kots', k);
    out.push(k);
  }
  return out;
}

// Sends new/changed items to the kitchen. Returns the KOTs created (one per kitchen station).
export async function sendToKitchen(order) {
  Auth.require('sale.create');
  const o = await saveOrder(order);
  const res = await idb.write(['orders', 'kots', 'meta'], async (t) => {
    const cur = await t.get('orders', o.id);
    const diffs = cur.lines.map((l) => ({ ...l, diff: round3(l.qty - (l.sent || 0)) })).filter((l) => l.diff !== 0);
    if (!diffs.length) return { order: cur, kots: [] };
    const kots = await makeKots(t, cur, diffs);
    cur.lines = cur.lines.map((l) => ({ ...l, sent: l.qty })).filter((l) => l.qty > 0);
    cur.kitchen = await kitchenState(t, cur.id);
    cur.updatedAt = nowISO();
    summarize(cur);
    await t.put('orders', cur);
    return { order: cur, kots };
  });
  notifyChanged();
  return res;
}

async function kitchenState(t, orderId) {
  const ks = (await t.getAllByIndex('kots', 'orderId', orderId)).filter((k) => !k.cancelTicket && k.status !== 'cancelled');
  if (!ks.length) return 'none';
  if (ks.some((k) => k.status === 'new')) return 'new';
  if (ks.some((k) => k.status === 'preparing')) return 'preparing';
  if (ks.some((k) => k.status === 'ready')) return 'ready';
  return 'served';
}

export async function setKotStatus(id, status) {
  if (!KOT_STATUS[status]) throw new AppError('Invalid status.');
  await idb.write(['kots', 'orders'], async (t) => {
    const k = await t.get('kots', id);
    if (!k) throw new AppError('Ticket not found.');
    k.status = status; k.updatedAt = nowISO();
    if (status === 'ready') k.readyAt = k.updatedAt;
    await t.put('kots', k);
    const o = await t.get('orders', k.orderId);
    if (o && o.status === 'open') { o.kitchen = await kitchenState(t, o.id); await t.put('orders', o); }
  });
  notifyChanged();
}

// Marks every ready ticket of an order as served (waiter took the food to the table).
export async function serveOrder(orderId) {
  await idb.write(['kots', 'orders'], async (t) => {
    for (const k of await t.getAllByIndex('kots', 'orderId', orderId)) {
      if (k.status === 'ready') { k.status = 'served'; k.updatedAt = nowISO(); await t.put('kots', k); }
    }
    const o = await t.get('orders', orderId);
    if (o && o.status === 'open') { o.kitchen = await kitchenState(t, o.id); await t.put('orders', o); }
  });
  notifyChanged();
}

// A paid dine-in/delivery order has been eaten/delivered: its tickets leave the kitchen screen.
export async function closeTickets(orderId) {
  await idb.write(['kots'], async (t) => {
    for (const k of await t.getAllByIndex('kots', 'orderId', orderId)) {
      if (['new', 'preparing', 'ready'].includes(k.status)) { k.status = 'served'; k.updatedAt = nowISO(); await t.put('kots', k); }
    }
  });
  notifyChanged();
}

export const openOrders = async () => (await idb.getAllByIndex('orders', 'status', 'open')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
// Tickets still waiting in the kitchen. Tickets of finished (paid/cancelled) orders drop off after 3 hours, so a
// restaurant that only uses printed tickets and never taps "Served" doesn't collect a screen full of old tickets.
const STALE_MS = 3 * 60 * 60 * 1000;
export async function kitchenTickets() {
  const [kots, open] = await idb.read(['kots', 'orders'], (t) => Promise.all([
    Promise.all(['new', 'preparing', 'ready'].map((s) => t.getAllByIndex('kots', 'status', s))),
    t.getAllByIndex('orders', 'status', 'open'),
  ]));
  const running = new Set(open.map((o) => o.id));
  const cutoff = Date.now() - STALE_MS;
  return kots.flat().filter((k) => running.has(k.orderId) || new Date(k.createdAt).getTime() > cutoff)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------- tables ----------
export const allTables = async () => (await idb.getAll('tables')).sort((a, b) => (a.area || '').localeCompare(b.area || '') || (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));

export async function saveTable(data) {
  Auth.require('settings.manage');
  const name = clean(data.name, 40);
  if (!name) throw new AppError('Table name is required.');
  const id = data.id || uuid();
  await idb.write(['tables'], async (t) => {
    const dup = (await t.getAll('tables')).find((x) => lc(x.name) === lc(name) && x.id !== id);
    if (dup) throw new AppError(`A table called "${name}" already exists.`);
    const old = data.id ? await t.get('tables', id) : null;
    await t.put('tables', { ...(old || { createdAt: nowISO() }), id, name, area: clean(data.area, 40), seats: Math.max(0, parseInt(data.seats, 10) || 0), sort: num(data.sort, old?.sort ?? 0), updatedAt: nowISO() });
  });
  notifyChanged();
  return id;
}

export async function addTables(count, prefix = 'T', area = '') {
  Auth.require('settings.manage');
  const n = Math.min(100, Math.max(1, parseInt(count, 10) || 0));
  await idb.write(['tables'], async (t) => {
    const names = new Set((await t.getAll('tables')).map((x) => lc(x.name)));
    let i = 1; let added = 0;
    while (added < n && i < 1000) {
      const name = `${prefix}${i}`;
      if (!names.has(lc(name))) { await t.put('tables', { id: uuid(), name, area: clean(area, 40), seats: 4, sort: i, createdAt: nowISO(), updatedAt: nowISO() }); added++; }
      i++;
    }
  });
  notifyChanged();
}

export async function deleteTable(id) {
  Auth.require('settings.manage');
  await idb.write(['tables', 'orders'], async (t) => {
    if ((await t.getAllByIndex('orders', 'status', 'open')).some((o) => o.tableId === id)) throw new AppError('This table has a running order. Close it first.');
    await t.delete('tables', id);
  });
  notifyChanged();
}

// ---------- staff ----------
export const allStaff = async () => (await idb.getAll('staff')).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));

export async function saveStaff(data) {
  Auth.require('account.manage');
  const name = clean(data.name, 120);
  if (!name) throw new AppError('Name is required.');
  if (!STAFF_ROLES[data.role]) throw new AppError('Select a job.');
  const salary = round2(num(data.salary));
  if (salary < 0) throw new AppError('Salary cannot be negative.');
  const id = data.id || uuid();
  const rec = await idb.write(['staff', 'auditLog'], async (t) => {
    const old = data.id ? await t.get('staff', id) : null;
    const r = { ...(old || { createdAt: nowISO() }), id, name, nameLc: lc(name), role: data.role, phone: clean(data.phone, 40), cnic: clean(data.cnic, 20),
      address: clean(data.address, 200), salary, joinDate: data.joinDate || old?.joinDate || today(), note: clean(data.note, 300),
      active: data.active === false ? 0 : 1, updatedAt: nowISO() };
    await t.put('staff', r);
    await t.add('auditLog', { id: uuid(), at: nowISO(), userId: Auth.user()?.id, userName: Auth.user()?.name, action: old ? 'update_staff' : 'create_staff', details: { name } });
    return r;
  });
  notifyChanged();
  return rec;
}

// Staff are never hard-deleted once paid, so salary history stays intact.
export async function deleteStaff(id) {
  Auth.require('account.manage');
  const res = await idb.write(['staff', 'vouchers'], async (t) => {
    const s = await t.get('staff', id);
    if (!s) throw new AppError('Not found.');
    const paid = (await t.getAllByIndex('vouchers', 'type', 'payment')).some((v) => v.staffId === id);
    if (paid) { s.active = 0; s.updatedAt = nowISO(); await t.put('staff', s); return 'deactivated'; }
    await t.delete('staff', id);
    return 'deleted';
  });
  notifyChanged();
  return res;
}

// Salary/advance payments of one person (from payment vouchers), newest first.
export async function staffPayments(staffId) {
  return (await idb.getAllByIndex('vouchers', 'type', 'payment')).filter((v) => v.staffId === staffId && v.status !== 'void')
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

// ---------- menu helpers ----------
export function lineFromProduct(p) {
  return { id: uuid(), productId: p.id, name: p.name, nameUr: p.nameUr || '', rate: p.salePrice || 0, qty: 0, sent: 0, note: '', station: p.station || stations()[0] };
}
export const productOf = (l) => Catalog.product(l.productId);
