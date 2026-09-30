// Staff & salaries. Each payment (salary or advance) is a payment voucher to the "Staff Salaries" expense account,
// tagged with the person and the month it belongs to, so "remaining this month" = salary − paid for that month.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, uuid, num, round2, AppError } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import { bi } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Orders from '../services/orders.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;
const R = Orders.STAFF_ROLES;
const thisMonth = () => today().slice(0, 7);
const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export async function editStaff(s = null) {
  return UI.formModal({
    title: s ? 'Edit staff member' : 'New staff member', size: 'lg',
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Job</label><div class="role-pick">${Object.entries(R).map(([k, [l, u, e]]) => `<input type="radio" class="btn-check" name="role" id="sr-${k}" value="${k}" ${(s?.role || 'waiter') === k ? 'checked' : ''}><label class="btn btn-outline-secondary role-btn" for="sr-${k}"><span class="fs-3">${e}</span>${bi(l, u)}</label>`).join('')}</div></div>
      <div class="col-md-6"><label class="form-label">Name *</label><input name="name" class="form-control form-control-lg" value="${esc(s?.name)}" required></div>
      <div class="col-md-6"><label class="form-label">Phone</label><input name="phone" class="form-control form-control-lg" inputmode="tel" value="${esc(s?.phone)}"></div>
      <div class="col-6"><label class="form-label">Monthly salary</label><input name="salary" class="form-control form-control-lg" inputmode="decimal" value="${s?.salary ?? ''}"></div>
      <div class="col-6"><label class="form-label">Joining date</label><input type="date" name="joinDate" class="form-control form-control-lg" value="${esc(s?.joinDate || today())}"></div>
      <div class="col-md-6"><label class="form-label">CNIC</label><input name="cnic" class="form-control" value="${esc(s?.cnic)}" placeholder="xxxxx-xxxxxxx-x"></div>
      <div class="col-md-6"><label class="form-label">Address</label><input name="address" class="form-control" value="${esc(s?.address)}"></div>
      <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" value="${esc(s?.note)}"></div>
      ${s ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="sf-active" ${s.active ? 'checked' : ''}><label class="form-check-label" for="sf-active">Still working here</label></div></div>` : ''}
    </div>`,
    onSubmit: async (v) => { const r = await Orders.saveStaff({ ...v, id: s?.id, active: s ? v.active : true }); UI.toast(s ? 'Saved' : 'Staff member added'); return r; },
  });
}

async function pay(s, kind, month, remaining) {
  const payAccounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active);
  const id = uuid();
  return UI.formModal({
    title: `${kind === 'advance' ? 'Advance to' : 'Pay salary to'} ${s.name}`, submitLabel: kind === 'advance' ? 'Give advance' : 'Pay salary', submitClass: 'btn-success btn-lg',
    body: `<label class="form-label">${bi('Amount', 'رقم')}</label>
      <input name="amount" class="form-control form-control-lg money text-center" inputmode="decimal" value="${kind === 'salary' && remaining > 0 ? remaining : ''}" required>
      <div class="row g-2 mt-2">
        <div class="col-6"><label class="form-label">For month</label><input type="month" name="month" class="form-control" value="${esc(month)}" required></div>
        <div class="col-6"><label class="form-label">Paid from</label><select name="accountId" class="form-select">${UI.options(payAccounts, 'cash')}</select></div>
        <div class="col-6"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${today()}" max="${today()}"></div>
        <div class="col-6"><label class="form-label">Note</label><input name="note" class="form-control"></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="print" id="sp-print"><label class="form-check-label" for="sp-print">Print slip</label></div></div>
      </div>`,
    onShown: ($m) => $m.find('[name=amount]').trigger('select'),
    onSubmit: async (v) => {
      if (!(num(v.amount) > 0)) throw new AppError('Enter the amount.');
      if (!/^\d{4}-\d{2}$/.test(v.month)) throw new AppError('Select the month.');
      const label = kind === 'advance' ? 'Advance' : 'Salary';
      const { doc } = await Posting.saveVoucher({ id, type: 'payment', accountId: v.accountId, counterAccountId: 'salaries', amount: round2(num(v.amount)), date: v.date,
        note: `${label} ${monthName(v.month)} — ${s.name}${v.note ? ' · ' + v.note : ''}`, staffId: s.id, staffName: s.name, payKind: kind, month: v.month });
      UI.toast(`${label} of ${getSettings().currency} ${fmtNum(doc.amount)} saved`);
      if (v.print) setTimeout(() => Printer.printDocument('voucher', doc), 300);
      return doc;
    },
  });
}

async function renderList(el) {
  const $el = $(el).off(); // re-rendered after each save: drop old handlers
  const [staff, pays] = await Promise.all([Orders.allStaff(), idb.getAllByIndex('vouchers', 'type', 'payment')]);
  const m = thisMonth();
  const paid = new Map();
  for (const v of pays) if (v.staffId && v.status !== 'void' && v.month === m) paid.set(v.staffId, round2((paid.get(v.staffId) || 0) + v.amount));
  const active = staff.filter((s) => s.active);
  const totalSalary = round2(active.reduce((a, s) => a + s.salary, 0));
  const totalPaid = round2(active.reduce((a, s) => a + (paid.get(s.id) || 0), 0));
  $el.html(`${UI.pageHeader('Staff & salaries', Auth.can('account.manage') ? '<button class="btn btn-primary btn-add"><i class="bi bi-person-plus"></i> Add</button>' : '')}
    <div class="row g-2 mb-3">
      <div class="col-4"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Staff</div><div class="stat-value">${active.length}</div></div></div></div>
      <div class="col-4"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Salaries / month</div><div class="stat-value money">${fmtNum(totalSalary)}</div></div></div></div>
      <div class="col-4"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Paid ${esc(monthName(m).split(' ')[0])}</div><div class="stat-value money">${fmtNum(totalPaid)}</div></div></div></div>
    </div>
    <div class="staff-grid">${staff.map((s) => {
      const [l, u, e] = R[s.role] || ['Staff', '', '🧑'];
      const rem = round2(s.salary - (paid.get(s.id) || 0));
      return `<a class="staff-card ${s.active ? '' : 'inactive'}" href="#/staff/${encodeURIComponent(s.id)}">
        <span class="staff-emoji">${e}</span>
        <span class="staff-main"><span class="staff-name">${esc(s.name)}</span><span class="staff-role">${bi(l, u)}${s.active ? '' : ' · left'}</span></span>
        <span class="staff-end">${s.salary ? `<span class="money">${fmtNum(s.salary)}</span><span class="small ${rem > 0 ? 'text-danger' : 'text-success'}">${rem > 0 ? `${fmtNum(rem)} due` : 'paid ✓'}</span>` : ''}</span></a>`;
    }).join('') || UI.emptyState('No staff added yet', 'people')}</div>`);
  $el.on('click', '.btn-add', async () => { if (await editStaff()) renderList(el); });
}

async function renderDetail(el, id) {
  const $el = $(el).off();
  const s = await idb.get('staff', id);
  if (!s) { $el.html(UI.pageHeader('Staff', '', '#/staff') + UI.emptyState('Not found', 'x-circle')); return; }
  let month = thisMonth();
  const draw = async () => {
    const pays = await Orders.staffPayments(s.id);
    const inMonth = pays.filter((v) => v.month === month);
    const paid = round2(inMonth.reduce((a, v) => a + v.amount, 0));
    const adv = round2(inMonth.filter((v) => v.payKind === 'advance').reduce((a, v) => a + v.amount, 0));
    const rem = round2(s.salary - paid);
    const [l, u, e] = R[s.role] || ['Staff', '', '🧑'];
    const manage = Auth.can('account.manage');
    $el.html(`${UI.pageHeader(s.name, manage ? '<button class="btn btn-light btn-sm btn-edit"><i class="bi bi-pencil"></i> Edit</button>' : '', '#/staff')}
      <div class="card mb-3"><div class="card-body d-flex flex-wrap align-items-center gap-3">
        <span class="staff-emoji big">${e}</span>
        <div class="flex-grow-1"><div class="fw-semibold">${bi(l, u)}</div><div class="small text-body-secondary">${s.phone ? `<a href="tel:${esc(s.phone)}">${esc(s.phone)}</a> · ` : ''}since ${fmtDate(s.joinDate)}${s.active ? '' : ' · <b>left</b>'}</div></div>
        <input type="month" class="form-control f-month staff-month" value="${esc(month)}">
      </div></div>
      <div class="row g-2 mb-3">
        <div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Salary</div><div class="stat-value money">${fmtNum(s.salary)}</div></div></div></div>
        <div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Advances</div><div class="stat-value money">${fmtNum(adv)}</div></div></div></div>
        <div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">Paid in ${esc(monthName(month))}</div><div class="stat-value money">${fmtNum(paid)}</div></div></div></div>
        <div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">${rem >= 0 ? 'Still to pay' : 'Paid extra'}</div><div class="stat-value money ${rem > 0 ? 'text-danger' : 'text-success'}">${fmtNum(Math.abs(rem))}</div></div></div></div>
      </div>
      ${manage ? `<div class="staff-actions mb-3"><button class="btn btn-success btn-pay" data-k="salary"><span class="fs-3">💵</span>${bi('Pay salary', 'تنخواہ دیں')}</button>
        <button class="btn btn-warning btn-pay" data-k="advance"><span class="fs-3">🤝</span>${bi('Give advance', 'ایڈوانس دیں')}</button></div>` : ''}
      <h2 class="h6 text-body-secondary">All payments</h2>
      <div class="list-card">${pays.map((v) => `<a class="list-row" href="#/vouchers/${encodeURIComponent(v.id)}">
        <div class="main"><div class="title">${v.payKind === 'advance' ? 'Advance' : 'Salary'} · ${esc(monthName(v.month || v.date.slice(0, 7)))}</div><div class="sub">${esc(v.number)} · ${fmtDate(v.date)} · ${esc(v.accountName)}</div></div>
        <div class="end fw-semibold money">${fmtNum(v.amount)}</div></a>`).join('') || UI.emptyState('No payments yet', 'cash')}</div>
      ${manage && s.active ? '<button class="btn btn-outline-danger btn-sm mt-3 btn-del"><i class="bi bi-person-x me-1"></i>Remove / left the job</button>' : ''}`);
  };
  await draw();
  $el.on('change', '.f-month', function () { if (this.value) { month = this.value; draw(); } });
  $el.on('click', '.btn-pay', async function () {
    const pays = await Orders.staffPayments(s.id);
    const rem = round2(s.salary - pays.filter((v) => v.month === month).reduce((a, v) => a + v.amount, 0));
    if (await pay(s, this.dataset.k, month, rem)) draw();
  });
  $el.on('click', '.btn-edit', async () => { const r = await editStaff(s); if (r) { Object.assign(s, r); draw(); } });
  $el.on('click', '.btn-del', async () => {
    if (!await UI.confirmDialog(`Remove ${s.name}? Their salary history stays in the records.`, { okLabel: 'Remove', okClass: 'btn-danger' })) return;
    try { const r = await Orders.deleteStaff(s.id); UI.toast(r === 'deleted' ? 'Removed' : 'Marked as left'); location.hash = '#/staff'; } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el, { params }) {
    if (params[0]) await renderDetail(el, params[0]); else await renderList(el);
  },
};

