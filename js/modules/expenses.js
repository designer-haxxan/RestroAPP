// Daily expenses: tap a picture (Gas, Electricity, Vegetables…), type the amount, done.
// Each expense is a payment voucher from cash/bank to an expense account, so it shows in the cash book and profit.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, monthStart, uuid, num, round2, AppError } from '../core/utils.js';
import { money } from '../core/views.js';
import { getSettings } from '../core/settings.js';
import { bi } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';

const $ = window.jQuery;
const HIDDEN = new Set(['purchases', 'purchase_returns', 'salaries']);
const EMOJIS = ['🔥', '💡', '🏠', '🥬', '💧', '🥡', '⛽', '🔧', '🧹', '🧾', '📱', '🧂', '🍗', '🛢️', '🧊', '🚚', '🎁', '💸'];
let range = 'today';

const heads = async () => (await idb.getAll('accounts')).filter((a) => a.type === 'expense' && a.active && !HIDDEN.has(a.id))
  .sort((a, b) => (a.id === 'expense' ? 1 : b.id === 'expense' ? -1 : a.name.localeCompare(b.name)));

async function addExpense(head) {
  const payAccounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active);
  const id = uuid();
  return UI.formModal({
    title: `${head.emoji || '💸'} ${head.name}`, submitLabel: 'Save expense', submitClass: 'btn-danger btn-lg',
    body: `<label class="form-label">${bi('Amount', 'رقم')}</label>
      <input name="amount" class="form-control form-control-lg money text-center exp-amount" inputmode="decimal" placeholder="0" required>
      <label class="form-label mt-3">${bi('Paid from', 'کہاں سے دیے')}</label>
      <div class="btn-group w-100 mb-3 flex-wrap" role="group">${payAccounts.map((a, i) => `<input type="radio" class="btn-check" name="accountId" id="ea-${i}" value="${esc(a.id)}" ${a.id === 'cash' ? 'checked' : ''}><label class="btn btn-outline-secondary py-2" for="ea-${i}">${esc(a.name)}</label>`).join('')}</div>
      <div class="row g-2"><div class="col-7"><label class="form-label">Note</label><input name="note" class="form-control" placeholder="e.g. 2 cylinders"></div>
      <div class="col-5"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${today()}" max="${today()}"></div></div>`,
    onShown: ($m) => $m.find('[name=amount]').trigger('focus'),
    onSubmit: async (v) => {
      if (!(num(v.amount) > 0)) throw new AppError('Enter the amount.');
      const { doc } = await Posting.saveVoucher({ id, type: 'payment', accountId: v.accountId || 'cash', counterAccountId: head.id, amount: round2(num(v.amount)), note: v.note, date: v.date });
      UI.toast(`${head.name}: ${getSettings().currency} ${fmtNum(doc.amount)} saved`);
      return doc;
    },
  });
}

async function newHead() {
  let emoji = '💸';
  return UI.formModal({
    title: 'New expense type',
    body: `<label class="form-label">Name</label><input name="name" class="form-control form-control-lg mb-3" placeholder="e.g. Chicken supply, Internet" required>
      <label class="form-label">Picture</label><div class="emoji-pick">${EMOJIS.map((e) => `<button type="button" class="emoji-btn ${e === emoji ? 'active' : ''}">${e}</button>`).join('')}</div>`,
    onShown: ($m) => $m.on('click', '.emoji-btn', function () { emoji = this.textContent; $m.find('.emoji-btn').removeClass('active'); $(this).addClass('active'); }),
    onSubmit: async (v) => { if (!v.name.trim()) throw new AppError('Enter a name.'); return Posting.saveAccount({ name: v.name, type: 'expense', emoji }); },
  });
}

async function draw($el) {
  const [from, to] = range === 'today' ? [today(), today()] : [monthStart(), today()];
  const [list, hs] = await Promise.all([idb.getAllByIndex('vouchers', 'date', IDBKeyRange.bound(from, to)), heads()]);
  const exp = list.filter((v) => v.type === 'payment' && v.status !== 'void' && v.counterType === 'expense')
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const total = round2(exp.reduce((s, v) => s + v.amount, 0));
  const by = new Map(); for (const v of exp) by.set(v.counterAccountId, round2((by.get(v.counterAccountId) || 0) + v.amount));
  $el.find('.exp-heads').html(hs.map((h) => `<button class="exp-tile" data-id="${esc(h.id)}"><span class="exp-emoji">${esc(h.emoji || '💸')}</span><span class="exp-name">${esc(h.name)}</span>
      ${by.get(h.id) ? `<span class="exp-sum">${fmtNum(by.get(h.id))}</span>` : ''}</button>`).join('')
    + (Auth.can('account.manage') ? `<button class="exp-tile exp-new"><span class="exp-emoji">➕</span><span class="exp-name">${bi('New type', 'نئی قسم')}</span></button>` : ''));
  $el.find('.exp-range').html(['today', 'month'].map((r) => `<button class="chip ${range === r ? 'active' : ''}" data-r="${r}">${r === 'today' ? 'Today' : 'This month'}</button>`).join(''));
  $el.find('.exp-total').html(`${bi(range === 'today' ? 'Spent today' : 'Spent this month', range === 'today' ? 'آج کا خرچہ' : 'اس مہینے کا خرچہ')}<b class="money">${money(total)}</b>`);
  $el.find('.exp-list').html(exp.length ? exp.map((v) => `<a class="list-row" href="#/vouchers/${encodeURIComponent(v.id)}">
      <div class="thumb fs-4">${esc(hs.find((h) => h.id === v.counterAccountId)?.emoji || '💸')}</div>
      <div class="main"><div class="title">${esc(v.counterName)}</div><div class="sub">${fmtDate(v.date)} · ${esc(v.accountName)}${v.note ? ' · ' + esc(v.note) : ''}</div></div>
      <div class="end fw-semibold money text-danger">−${fmtNum(v.amount)}</div></a>`).join('') : UI.emptyState('No expenses in this period', 'wallet2'));
}

export default {
  async render(el) {
    const $el = $(el);
    $el.html(`${UI.pageHeader('Expenses', '<a class="btn btn-light btn-sm" href="#/reports/expenses"><i class="bi bi-bar-chart-line"></i> Report</a>')}
      <div class="small text-body-secondary mb-2">${bi('Tap what you paid for', 'جس چیز کے پیسے دیے اس پر ٹچ کریں')}</div>
      <div class="exp-heads mb-3"></div>
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2"><div class="chips exp-range"></div><div class="exp-total ms-auto"></div></div>
      <div class="list-card exp-list"></div>
      <div class="small text-body-secondary mt-2">Salaries are paid from <a href="#/staff">Staff</a>. Buying stock for the kitchen goes in <a href="#/purchases">Purchases</a>.</div>`);
    $el.on('click', '.exp-tile[data-id]', async function () {
      if (!Auth.can('account.manage')) return UI.toast('You do not have permission to add expenses', 'warning');
      const h = (await heads()).find((x) => x.id === this.dataset.id);
      if (h && await addExpense(h)) draw($el);
    });
    $el.on('click', '.exp-new', async () => { if (await newHead()) draw($el); });
    $el.on('click', '.exp-range [data-r]', function () { range = this.dataset.r; draw($el); });
    await draw($el);
    UI.animateIn($el.find('.exp-heads'));
  },
};
