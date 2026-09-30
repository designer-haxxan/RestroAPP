// Dining tables: add one, add many at once (T1…T10), rename, group by area (Hall, Roof, Family…), delete.
import * as UI from '../core/ui.js';
import { esc, AppError } from '../core/utils.js';
import * as Orders from '../services/orders.js';

const $ = window.jQuery;

async function editTable(t = null) {
  return UI.formModal({
    title: t ? 'Edit table' : 'New table',
    body: `<div class="row g-2">
      <div class="col-6"><label class="form-label">Table name *</label><input name="name" class="form-control form-control-lg" value="${esc(t?.name)}" placeholder="T1, Family 2…" required></div>
      <div class="col-6"><label class="form-label">Seats</label><input name="seats" class="form-control form-control-lg" inputmode="numeric" value="${t?.seats ?? 4}"></div>
      <div class="col-12"><label class="form-label">Area (optional)</label><input name="area" class="form-control" value="${esc(t?.area)}" placeholder="Hall, Roof, Family hall…" list="area-list"></div></div>`,
    onSubmit: async (v) => { await Orders.saveTable({ ...v, id: t?.id }); return true; },
  });
}

async function draw($el) {
  const tables = await Orders.allTables();
  const areas = [...new Set(tables.map((t) => t.area || ''))];
  $el.find('#area-list').html(areas.filter(Boolean).map((a) => `<option value="${esc(a)}">`).join(''));
  $el.find('.tlist').html(tables.length ? areas.map((a) => `<h2 class="h6 text-body-secondary mt-3">${esc(a || 'Tables')}</h2>
    <div class="table-grid">${tables.filter((t) => (t.area || '') === a).map((t) => `<button class="table-tile free t-edit" data-id="${esc(t.id)}">
      <span class="table-name">${esc(t.name)}</span><span class="table-free"><i class="bi bi-people"></i> ${t.seats || '—'}</span></button>`).join('')}</div>`).join('')
    : UI.emptyState('No tables yet. Add them one by one, or many at once.', 'grid-3x3'));
  return tables;
}

export default {
  async render(el) {
    const $el = $(el);
    $el.html(`${UI.pageHeader('Tables', `<button class="btn btn-light btn-bulk"><i class="bi bi-grid-3x3-gap"></i> Add many</button><button class="btn btn-primary btn-add"><i class="bi bi-plus-lg"></i> Add</button>`)}
      <datalist id="area-list"></datalist><div class="small text-body-secondary">Tap a table to rename or delete it.</div><div class="tlist"></div>`);
    let tables = await draw($el);
    $el.on('click', '.btn-add', async () => { if (await editTable()) tables = await draw($el); });
    $el.on('click', '.btn-bulk', async () => {
      const r = await UI.formModal({ title: 'Add many tables', submitLabel: 'Add tables',
        body: `<div class="row g-2"><div class="col-4"><label class="form-label">How many</label><input name="count" class="form-control form-control-lg" inputmode="numeric" value="10"></div>
          <div class="col-4"><label class="form-label">Name starts with</label><input name="prefix" class="form-control form-control-lg" value="T"></div>
          <div class="col-4"><label class="form-label">Area</label><input name="area" class="form-control form-control-lg" placeholder="Hall" list="area-list"></div></div>
          <div class="form-text">Creates T1, T2, T3… (numbers already used are skipped).</div>`,
        onSubmit: async (v) => { if (!(parseInt(v.count, 10) > 0)) throw new AppError('Enter how many tables.'); await Orders.addTables(v.count, v.prefix.trim(), v.area); return true; } });
      if (r) tables = await draw($el);
    });
    $el.on('click', '.t-edit', async function () {
      const t = tables.find((x) => x.id === this.dataset.id);
      const m = UI.modal({ title: t.name, fullscreenMobile: false, body: `<div class="d-grid gap-2"><button class="btn btn-primary btn-lg b-edit"><i class="bi bi-pencil me-1"></i>Rename / edit</button><button class="btn btn-outline-danger btn-lg b-del"><i class="bi bi-trash me-1"></i>Delete</button></div>` });
      m.$el.find('.b-edit').on('click', async () => { m.close(); await m.closed; if (await editTable(t)) tables = await draw($el); });
      m.$el.find('.b-del').on('click', async () => {
        m.close(); await m.closed;
        if (!await UI.confirmDialog(`Delete table ${t.name}?`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
        try { await Orders.deleteTable(t.id); tables = await draw($el); } catch (e) { UI.toastError(e); }
      });
    });
  },
};
