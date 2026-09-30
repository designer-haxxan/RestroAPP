// Builds a printer-independent receipt model and renders it to ESC/POS bytes or HTML.
import * as idb from '../db/idb.js';
import { getSettings } from '../core/settings.js';
import { fmtNum, fmtQty, fmtDateTime, fmtDate, esc, localDate } from '../core/utils.js';
import { EscPos, isPlain } from './escpos.js';
import * as Raster from './raster.js';

const ORDER_TYPE_LABEL = { dine: 'DINE-IN', take: 'TAKEAWAY', delivery: 'DELIVERY' };
const TITLES = { sale: 'BILL', purchase: 'PURCHASE', saleReturn: 'SALE RETURN', purchaseReturn: 'PURCHASE RETURN', receipt: 'PAYMENT RECEIPT', payment: 'PAYMENT VOUCHER', transfer: 'TRANSFER' };

export async function buildReceipt(kind, doc) {
  const s = getSettings();
  const b = s.business;
  const m = { header: [b.name, b.address, b.phone ? 'Tel: ' + b.phone : '', b.taxNo ? 'Tax No: ' + b.taxNo : ''].filter(Boolean), title: TITLES[kind] || kind.toUpperCase(),
    info: [], items: [], totals: [], footer: b.footer || '', void: doc.status === 'void' };
  const sameDay = doc.createdAt && localDate(new Date(doc.createdAt)) === doc.date;
  m.info.push(['No', doc.number], ['Date', sameDay ? fmtDateTime(doc.createdAt) : fmtDate(doc.date)]);
  if (doc.userName) m.info.push(['User', doc.userName]);

  if (kind === 'sale' || kind === 'purchase') {
    const items = await idb.getAllByIndex(kind === 'sale' ? 'saleItems' : 'purchaseItems', kind === 'sale' ? 'saleId' : 'purchaseId', doc.id);
    const list = items.length ? items : (doc.voidedItems || []);
    list.sort((a, b) => a.line - b.line);
    const o = doc.order;
    if (o) {
      m.title = `${TITLES[kind]} - ${ORDER_TYPE_LABEL[o.type] || ''}`;
      m.info.push(['Order', '#' + String(o.number || '').replace(/^.*?-0*(?=\d)/, '')]);
      if (o.tableName) m.info.push(['Table', o.tableName]);
      if (o.waiterName) m.info.push(['Waiter', o.waiterName]);
    }
    if (kind === 'purchase' || !o || doc.customerId || doc.customerName !== 'Walk-in Customer') m.info.push([kind === 'sale' ? 'Customer' : 'Supplier', kind === 'sale' ? doc.customerName : doc.supplierName]);
    if (o?.phone) m.info.push(['Phone', o.phone]);
    if (o?.address) m.info.push(['Address', o.address]);
    if (o?.riderName) m.info.push(['Rider', o.riderName]);
    m.items = list.map((i) => ({ name: i.name, qty: i.qty, unit: o ? '' : i.unit, rate: i.rate, discount: i.discount, amount: i.amount, note: i.note }));
    m.totals.push(['Subtotal', doc.subtotal]);
    if (doc.discount) m.totals.push(['Discount', -doc.discount]);
    if (doc.tax) m.totals.push([`Tax (${doc.taxRate}%)`, doc.tax]);
    if (doc.charge) m.totals.push([doc.chargeLabel || 'Charges', doc.charge]);
    m.totals.push(['TOTAL', doc.total, true]);
    if (kind === 'sale' && doc.tendered > doc.paid) m.totals.push(['Cash tendered', doc.tendered]);
    m.totals.push(['Paid', doc.paid]);
    if (doc.change) m.totals.push(['Change', doc.change]);
    if (doc.balance) m.totals.push(['Balance due', doc.balance, true]);
    m.payment = doc.paid ? doc.paymentAccountName : 'Credit';
  } else if (kind === 'saleReturn' || kind === 'purchaseReturn') {
    m.info.push(['Against', doc.docNo], [kind === 'saleReturn' ? 'Customer' : 'Supplier', doc.partyName || '']);
    m.items = doc.items.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, amount: i.amount }));
    m.totals.push(['RETURN TOTAL', doc.total, true]);
    m.totals.push([kind === 'saleReturn' ? 'Refunded' : 'Refund received', doc.refund]);
    m.payment = doc.refund ? doc.refundAccountName : 'Adjusted to account';
  } else {
    const party = { receipt: 'Received from', payment: 'Paid to', transfer: 'To account' }[doc.type];
    m.title = TITLES[doc.type];
    m.info.push([party, doc.counterName], [doc.type === 'transfer' ? 'From account' : 'Account', doc.accountName]);
    if (doc.note) m.info.push(['Note', doc.note]);
    m.totals.push(['AMOUNT', doc.amount, true]);
  }
  if (doc.note && kind !== 'voucher') m.note = doc.note;
  return m;
}

// Async because Urdu/non-Latin lines are rendered with the Jameel Noori Nastaleeq web font.
export async function toEscPos(m, width = 58) {
  await Raster.ensureFont();
  const p = new EscPos(width, Raster, { imageMode: getSettings().printer.imageMode });
  const cur = getSettings().currency;
  p.align('center');
  m.header.forEach((h, i) => { if (i === 0) p.bold(true).size(true).wrap(h, Math.floor(p.cols / 2)).size(false).bold(false); else p.wrap(h); });
  p.hr().bold(true).line(m.title).bold(false);
  if (m.void) p.bold(true).line('*** VOID ***').bold(false);
  p.align('left');
  m.info.forEach(([k, v]) => p.lr(k + ':', String(v ?? '')));
  if (m.items.length) {
    p.hr();
    m.items.forEach((i) => {
      p.wrap(i.name);
      p.lr(`  ${fmtQty(i.qty)} ${i.unit || ''} x ${fmtNum(i.rate)}`, fmtNum(i.amount));
      if (i.discount) p.lr('  Discount', '-' + fmtNum(i.discount));
      if (i.note) p.wrap('  * ' + i.note);
    });
  }
  p.hr();
  m.totals.forEach(([k, v, strong]) => { if (strong) p.bold(true); p.lr(k, `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`); if (strong) p.bold(false); });
  if (m.payment) p.lr('Payment', m.payment);
  if (m.note) { p.hr(); p.wrap('Note: ' + m.note); }
  p.hr().align('center');
  if (m.footer) p.wrap(m.footer);
  p.feed(3).cut();
  return p.bytes();
}

// Urdu/RTL text is wrapped so it uses Jameel Noori Nastaleeq and right-to-left layout.
const t = (s) => (isPlain(s) ? esc(s) : `<span class="ur" dir="auto">${esc(s)}</span>`);

export function toHTML(m, width = 58) {
  const cur = esc(getSettings().currency);
  const row = (l, r, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${r}</td></tr>`;
  return `<div class="receipt w${Number(width) === 80 ? 80 : 58}">
    ${m.header.map((h, i) => `<div class="c ${i === 0 ? 'b big' : ''}">${t(h)}</div>`).join('')}
    <hr><div class="c b">${esc(m.title)}</div>${m.void ? '<div class="c b">*** VOID ***</div>' : ''}
    <table>${m.info.map(([k, v]) => row(esc(k) + ':', t(v))).join('')}</table>
    ${m.items.length ? '<hr><table>' + m.items.map((i) => `<tr><td colspan="2">${t(i.name)}</td></tr>${row(`&nbsp;&nbsp;${fmtQty(i.qty)} ${esc(i.unit || '')} x ${fmtNum(i.rate)}`, fmtNum(i.amount))}${i.discount ? row('&nbsp;&nbsp;Discount', '-' + fmtNum(i.discount)) : ''}${i.note ? `<tr><td colspan="2">&nbsp;&nbsp;* ${t(i.note)}</td></tr>` : ''}`).join('') + '</table>' : ''}
    <hr><table>${m.totals.map(([k, v, strong]) => row(esc(k), `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`, strong ? 'b' : '')).join('')}
    ${m.payment ? row('Payment', t(m.payment)) : ''}</table>
    ${m.note ? `<hr><div>Note: ${t(m.note)}</div>` : ''}
    <hr>${m.footer ? `<div class="c">${t(m.footer)}</div>` : ''}</div>`;
}

// ---------- Kitchen order ticket (KOT) ----------
// Printed for the cook: large text, quantities first, notes and cancellations stand out, no prices.
export function buildKot(k) {
  const type = ORDER_TYPE_LABEL[k.type] || '';
  return {
    title: k.cancelTicket ? '*** CANCEL ***' : 'KITCHEN ORDER',
    big: [`KOT #${String(k.number).replace(/^.*?-0*(?=\d)/, '')}`, k.tableName ? `${type} - ${k.tableName}` : type],
    info: [['Order', '#' + String(k.orderNo).replace(/^.*?-0*(?=\d)/, '')], ['Time', fmtDateTime(k.createdAt)], ['Station', k.station],
      ...(k.waiterName ? [['Waiter', k.waiterName]] : []), ...(k.customerName ? [['Customer', k.customerName]] : [])],
    items: k.items, note: k.note,
  };
}

export async function kotEscPos(k, width = 58) {
  await Raster.ensureFont();
  const m = buildKot(k);
  const p = new EscPos(width, Raster, { imageMode: getSettings().printer.imageMode });
  p.align('center').bold(true).line(m.title).size(true);
  m.big.forEach((b) => p.wrap(b, Math.floor(p.cols / 2)));
  p.size(false).bold(false).align('left');
  m.info.forEach(([a, b]) => p.lr(a + ':', String(b ?? '')));
  p.hr();
  for (const i of m.items) {
    p.bold(true).size(true).wrap(`${i.cancel ? 'CANCEL ' : ''}${fmtQty(i.qty)} x ${i.name}`, Math.floor(p.cols / 2)).size(false).bold(false);
    if (i.nameUr) p.align('right').line(i.nameUr).align('left');
    if (i.note) p.wrap('  >> ' + i.note);
  }
  if (m.note) { p.hr(); p.wrap('Note: ' + m.note); }
  p.hr().feed(3).cut();
  return p.bytes();
}

export function kotHTML(k, width = 58) {
  const m = buildKot(k);
  return `<div class="receipt kot w${Number(width) === 80 ? 80 : 58}">
    <div class="c b">${esc(m.title)}</div>${m.big.map((b) => `<div class="c b kot-big">${esc(b)}</div>`).join('')}
    <table>${m.info.map(([a, b]) => `<tr><td>${esc(a)}:</td><td class="r">${t(b)}</td></tr>`).join('')}</table><hr>
    ${m.items.map((i) => `<div class="kot-item ${i.cancel ? 'kot-cancel' : ''}"><b>${i.cancel ? 'CANCEL ' : ''}${fmtQty(i.qty)} × ${t(i.name)}</b>
      ${i.nameUr ? `<div class="r">${t(i.nameUr)}</div>` : ''}${i.note ? `<div>&gt;&gt; ${t(i.note)}</div>` : ''}</div>`).join('')}
    ${m.note ? `<hr><div>Note: ${t(m.note)}</div>` : ''}<hr></div>`;
}

// Bill model for an open (unpaid) order.
export function orderBillModel(o, tot) {
  const b = getSettings().business;
  const m = { header: [b.name, b.address, b.phone ? 'Tel: ' + b.phone : ''].filter(Boolean), title: `BILL - ${ORDER_TYPE_LABEL[o.type] || ''}`,
    info: [['Order', '#' + String(o.number || '').replace(/^.*?-0*(?=\d)/, '')], ['Date', fmtDateTime(new Date().toISOString())]], items: [], totals: [], footer: b.footer || '' };
  if (o.tableName) m.info.push(['Table', o.tableName]);
  if (o.waiterName) m.info.push(['Waiter', o.waiterName]);
  if (o.customerName) m.info.push(['Customer', o.customerName]);
  if (o.phone) m.info.push(['Phone', o.phone]);
  if (o.address) m.info.push(['Address', o.address]);
  m.items = o.lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: l.qty, rate: l.rate, amount: l.qty * l.rate, note: l.note }));
  m.totals.push(['Subtotal', tot.subtotal]);
  if (tot.discount) m.totals.push(['Discount', -tot.discount]);
  if (tot.tax) m.totals.push([`Tax (${tot.taxRate}%)`, tot.tax]);
  if (tot.charge) m.totals.push([o.type === 'delivery' ? 'Delivery charges' : 'Service charges', tot.charge]);
  m.totals.push(['TOTAL', tot.total, true]);
  m.payment = 'NOT PAID YET';
  return m;
}
