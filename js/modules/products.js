// Menu & stock items.
//  Menu items: what guests order (price, picture/emoji, kitchen station, optional recipe that uses up stock items).
//  Stock items: raw material bought from suppliers and used in the kitchen (chicken, oil, rice…), with stock levels.
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, debounce, compressImage, AppError, num, round3 } from '../core/utils.js';
import { money, pager } from '../core/views.js';
import { pref } from '../core/settings.js';
import { bi } from '../core/i18n.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Orders from '../services/orders.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;
const UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'plate', 'half', 'dozen', 'pack', 'bottle', 'can', 'box'];
const FOOD_EMOJI = ['🍛', '🍚', '🍗', '🍖', '🥩', '🍔', '🍕', '🌯', '🥪', '🍟', '🥗', '🍜', '🍲', '🥘', '🍳', '🥚', '🫓', '🥙', '🍢', '🐟', '🦐', '🍰', '🍨', '🍮', '🥤', '🧃', '☕', '🍵', '🥛', '💧', '🍋', '🌶️'];

export async function editProduct(product = null, prefill = {}) {
  const p = { unit: 'pcs', kind: 'menu', active: 1, ...prefill, ...(product || {}) };
  let image = p.image || '';
  let emoji = p.emoji || '';
  let recipe = (p.recipe || []).map((r) => ({ ...r }));
  const cats = Catalog.allCategories();
  const sts = [...new Set([...Orders.stations(), ...(p.station ? [p.station] : [])])];
  const stockItems = () => Catalog.allProducts().filter((x) => x.active && x.id !== p.id && !x.recipe?.length && Catalog.kindOf(x) === 'stock')
    .sort((a, b) => a.name.localeCompare(b.name));
  const recipeRows = () => recipe.map((r, i) => {
    const ing = Catalog.product(r.productId);
    return `<div class="input-group input-group-sm mb-1" data-i="${i}"><span class="input-group-text flex-grow-1 text-truncate">${esc(ing?.name || '?')}</span>
      <input class="form-control r-qty" style="max-width:90px" inputmode="decimal" value="${r.qty}"><span class="input-group-text">${esc(ing?.unit || '')}</span>
      <button type="button" class="btn btn-outline-danger r-del" aria-label="Remove"><i class="bi bi-x"></i></button></div>`;
  }).join('') || '<div class="small text-body-secondary mb-1">No ingredients. Add them to reduce stock automatically when this dish is sold.</div>';

  return UI.formModal({
    title: product ? `Edit ${p.name}` : 'New item', size: 'lg',
    body: `<div class="btn-group w-100 mb-3" role="group">
        <input type="radio" class="btn-check" name="kind" id="pk-menu" value="menu" ${Catalog.kindOf(p) === 'menu' ? 'checked' : ''}><label class="btn btn-outline-primary py-2" for="pk-menu">🍛 ${bi('Menu item', 'مینو آئٹم')}<div class="small">sold to guests</div></label>
        <input type="radio" class="btn-check" name="kind" id="pk-stock" value="stock" ${Catalog.kindOf(p) === 'stock' ? 'checked' : ''}><label class="btn btn-outline-primary py-2" for="pk-stock">📦 ${bi('Stock item', 'اسٹاک آئٹم')}<div class="small">raw material</div></label>
      </div>
      <div class="row g-2">
      <div class="col-md-6"><label class="form-label">${bi('Name', 'نام')}</label><input name="name" class="form-control form-control-lg" required maxlength="150" value="${esc(p.name)}" placeholder="e.g. Chicken Karahi / Cooking oil"></div>
      <div class="col-md-6"><label class="form-label">Name in Urdu (optional)</label><input name="nameUr" class="form-control form-control-lg" dir="rtl" lang="ur" value="${esc(p.nameUr)}" placeholder="چکن کڑاہی"></div>
      <div class="col-6 f-menu"><label class="form-label">${bi('Price', 'قیمت')}</label><input name="salePrice" class="form-control form-control-lg" inputmode="decimal" value="${p.salePrice ?? ''}" placeholder="0"></div>
      <div class="col-6 f-menu"><label class="form-label">${bi('Category', 'قسم')}</label><select name="categoryId" class="form-select form-select-lg"><option value="">—</option>${UI.options(cats, p.categoryId)}<option value="__new">➕ New category…</option></select></div>
      <div class="col-12 f-menu new-cat d-none"><div class="input-group"><span class="input-group-text">New category</span><input name="newCat" class="form-control" placeholder="e.g. BBQ, Drinks, Desserts"></div></div>
      ${sts.length > 1 ? `<div class="col-12 f-menu"><label class="form-label">Which kitchen makes it?</label><div class="btn-group w-100 flex-wrap" role="group">${sts.map((st, i) => `<input type="radio" class="btn-check" name="station" id="pst-${i}" value="${esc(st)}" ${st === (p.station || sts[0]) ? 'checked' : ''}><label class="btn btn-outline-secondary" for="pst-${i}">${esc(st)}</label>`).join('')}</div></div>`
        : `<input type="hidden" name="station" value="${esc(p.station || sts[0])}">`}
      <div class="col-12 f-menu"><label class="form-label">Picture</label>
        <div class="d-flex align-items-center gap-2 mb-2">
          <div class="thumb img-prev fs-3">${image ? `<img src="${image}" alt="" class="thumb">` : esc(emoji) || '<i class="bi bi-image"></i>'}</div>
          <input type="file" accept="image/*" class="form-control img-file"><button type="button" class="btn btn-outline-danger btn-img-rm ${image ? '' : 'd-none'}" aria-label="Remove photo"><i class="bi bi-x"></i></button></div>
        <div class="emoji-pick">${FOOD_EMOJI.map((e) => `<button type="button" class="emoji-btn ${e === emoji ? 'active' : ''}">${e}</button>`).join('')}</div>
        <div class="form-text">Take a photo or tap an emoji. It makes the item easy to find when ordering.</div></div>
      <details class="col-12 more-opts" ${Catalog.kindOf(p) === 'stock' || p.recipe?.length || p.trackStock === true ? 'open' : ''}>
        <summary class="f-menu">More options: recipe, cost, stock, code</summary>
        <div class="row g-2 mt-1">
        <div class="col-6"><label class="form-label">Unit</label><input name="unit" class="form-control" list="unit-list" value="${esc(p.unit)}"><datalist id="unit-list">${UNITS.map((u) => `<option value="${u}">`).join('')}</datalist></div>
        <div class="col-6"><label class="form-label">Cost price <span class="f-stock-kind">(per unit)</span></label><input name="purchasePrice" class="form-control" inputmode="decimal" value="${p.purchasePrice ?? ''}"><div class="form-text f-menu">Leave 0 if it has a recipe.</div></div>
        <div class="col-12 f-menu"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="trackStock" id="pr-track" ${p.trackStock === true && Catalog.kindOf(p) === 'menu' ? 'checked' : ''}><label class="form-check-label" for="pr-track">Keep stock of this item itself (e.g. cold drink bottles, water)</label></div></div>
        <div class="col-4 f-stock"><label class="form-label">${product ? 'Opening stock' : 'Stock now'}</label><input name="openingStock" class="form-control" inputmode="decimal" value="${p.openingStock ?? ''}"></div>
        <div class="col-4 f-stock"><label class="form-label">Alert below</label><input name="minStock" class="form-control" inputmode="decimal" value="${p.minStock ?? ''}"></div>
        <div class="col-4 f-stock"><label class="form-label">Current stock</label><input class="form-control" value="${fmtQty(p.stock || 0)}" disabled></div>
        <div class="col-12 f-menu f-recipe"><label class="form-label">Recipe: stock used for ONE ${esc(p.unit || 'plate')}</label>
          <div class="recipe-rows">${recipeRows()}</div>
          <button type="button" class="btn btn-outline-secondary btn-sm btn-add-ing"><i class="bi bi-plus-lg me-1"></i>Add ingredient</button></div>
        <div class="col-6"><label class="form-label">Code</label><input name="sku" class="form-control" value="${esc(p.sku)}"></div>
        <div class="col-6"><label class="form-label">Barcode</label><div class="input-group"><input name="barcode" class="form-control" value="${esc(p.barcode)}" inputmode="numeric">
          <button type="button" class="btn btn-outline-secondary btn-scan-bc" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button></div></div>
        </div></details>
      ${product ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="pr-active" ${p.active ? 'checked' : ''}><label class="form-check-label" for="pr-active">Available (show on the order screen)</label></div></div>` : ''}
    </div>`,
    onShown: ($m) => {
      const sync = () => {
        const kind = $m.find('[name=kind]:checked').val();
        const tracks = kind === 'stock' || $m.find('#pr-track').prop('checked');
        $m.find('.f-menu').toggleClass('d-none', kind !== 'menu');
        $m.find('.f-stock-kind').toggleClass('d-none', kind !== 'stock');
        $m.find('.f-stock').toggleClass('d-none', !tracks);
        if (kind === 'stock') $m.find('.more-opts').prop('open', true);
        $m.find('.new-cat').toggleClass('d-none', kind !== 'menu' || $m.find('[name=categoryId]').val() !== '__new');
        $m.find('.f-recipe').toggleClass('d-none', kind !== 'menu' || $m.find('#pr-track').prop('checked'));
      };
      $m.on('change', '[name=kind], #pr-track, [name=categoryId]', sync); sync();
      $m.on('change', '[name=categoryId]', function () { if (this.value === '__new') $m.find('[name=newCat]').trigger('focus'); });
      const redrawRecipe = () => $m.find('.recipe-rows').html(recipeRows());
      $m.on('input', '.r-qty', function () { recipe[+$(this).closest('[data-i]').data('i')].qty = round3(num(this.value)); });
      $m.on('click', '.r-del', function () { recipe.splice(+$(this).closest('[data-i]').data('i'), 1); redrawRecipe(); });
      $m.find('.btn-add-ing').on('click', async () => {
        const list = stockItems();
        if (!list.length) return UI.toast('Add stock items first (e.g. Chicken, Oil) — choose "Stock item" when adding.', 'info', 5000);
        $m.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
        const r = await UI.pick({ title: 'Ingredient', search: async (q) => list.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())).map((x) => ({ id: x.id, title: x.name, subtitle: `per ${x.unit}`, right: fmtQty(x.stock) })) });
        $m.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
        if (r && !recipe.some((x) => x.productId === r.id)) { recipe.push({ productId: r.id, qty: 1 }); redrawRecipe(); $m.find('.r-qty').last().trigger('select'); }
      });
      $m.on('click', '.emoji-btn', function () {
        emoji = emoji === this.textContent ? '' : this.textContent;
        $m.find('.emoji-btn').removeClass('active'); if (emoji) $(this).addClass('active');
        if (!image) $m.find('.img-prev').html(esc(emoji) || '<i class="bi bi-image"></i>');
      });
      $m.find('.btn-scan-bc').on('click', async () => {
        $m.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
        const code = await Scanner.scan();
        $m.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
        if (code) $m.find('[name=barcode]').val(code);
      });
      $m.find('.img-file').on('change', async function () {
        const f = this.files[0]; if (!f) return;
        try { image = await compressImage(f); $m.find('.img-prev').html(`<img src="${image}" alt="" class="thumb">`); $m.find('.btn-img-rm').removeClass('d-none'); } catch (e) { UI.toastError(e); }
      });
      $m.find('.btn-img-rm').on('click', function () { image = ''; $m.find('.img-prev').html(esc(emoji) || '<i class="bi bi-image"></i>'); $(this).addClass('d-none'); $m.find('.img-file').val(''); });
      $m.find('[name=name]').trigger('focus');
    },
    onSubmit: async (v) => {
      const kind = v.kind === 'stock' ? 'stock' : 'menu';
      if (!v.name.trim()) throw new AppError('Enter the name.');
      if (kind === 'menu' && v.salePrice === '') throw new AppError('Enter the price.');
      if (kind === 'menu' && v.categoryId === '__new') {
        if (!v.newCat.trim()) throw new AppError('Type the new category name.');
        v.categoryId = await Posting.saveCategory({ name: v.newCat, emoji: emoji || '🍴' });
      }
      if (v.categoryId === '__new') v.categoryId = '';
      const saved = await Posting.saveProduct({ ...v, id: product?.id, kind, image, emoji, recipe: v.trackStock ? [] : recipe,
        trackStock: kind === 'stock' || v.trackStock === true, salePrice: kind === 'stock' ? (product?.salePrice || 0) : v.salePrice, active: product ? v.active : true });
      UI.toast(product ? 'Saved' : 'Item added');
      return saved;
    },
  });
}

async function manageCategories() {
  const render = () => Catalog.allCategories().map((c) => {
    const n = Catalog.allProducts().filter((p) => p.categoryId === c.id).length;
    return `<div class="list-row"><div class="thumb fs-4">${esc(c.emoji || '🍴')}</div><div class="main"><div class="title">${esc(c.name)} ${c.nameUr ? `<span class="lbl-ur d-inline">${esc(c.nameUr)}</span>` : ''}</div><div class="sub">${n} item(s)</div></div>
      <button class="btn btn-sm btn-light btn-cat-edit" data-id="${esc(c.id)}" aria-label="Edit"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-sm btn-light btn-cat-del" data-id="${esc(c.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button></div>`;
  }).join('') || UI.emptyState('No categories yet', 'tags');
  const m = UI.modal({ title: 'Menu categories', body: `<button class="btn btn-primary w-100 mb-3 cat-add"><i class="bi bi-plus-lg me-1"></i>Add category</button><div class="list-card cat-list">${render()}</div>` });
  const refresh = () => m.$el.find('.cat-list').html(render());
  const edit = async (c = null) => {
    let emoji = c?.emoji || '🍴';
    m.$el.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
    await UI.formModal({ title: c ? 'Edit category' : 'New category',
      body: `<div class="row g-2"><div class="col-6"><label class="form-label">Name</label><input name="name" class="form-control form-control-lg" value="${esc(c?.name)}" placeholder="BBQ" required></div>
        <div class="col-6"><label class="form-label">Urdu name</label><input name="nameUr" class="form-control form-control-lg" dir="rtl" value="${esc(c?.nameUr)}" placeholder="باربی کیو"></div></div>
        <label class="form-label mt-2">Picture</label><div class="emoji-pick">${FOOD_EMOJI.map((e) => `<button type="button" class="emoji-btn ${e === emoji ? 'active' : ''}">${e}</button>`).join('')}</div>`,
      onShown: ($f) => $f.on('click', '.emoji-btn', function () { emoji = this.textContent; $f.find('.emoji-btn').removeClass('active'); $(this).addClass('active'); }),
      onSubmit: async (v) => { await Posting.saveCategory({ id: c?.id, name: v.name, nameUr: v.nameUr, emoji }); return true; } });
    m.$el.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
    refresh();
  };
  m.$el.find('.cat-add').on('click', () => edit());
  m.$el.on('click', '.btn-cat-edit', function () { edit(Catalog.category(this.dataset.id)); });
  m.$el.on('click', '.btn-cat-del', async function () {
    try { await Posting.deleteCategory(this.dataset.id); refresh(); } catch (err) { UI.toastError(err); }
  });
  await m.closed;
}

async function renderList(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('product.edit');
  let kind = pref.get('productsTab', 'menu');
  $el.html(UI.pageHeader('Menu & stock items', canEdit ? `<button class="btn btn-light btn-sm btn-cats"><i class="bi bi-tags"></i> Categories</button><button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> Add</button>` : '') + `
    <div class="otabs mb-3 ptabs"></div>
    <div class="filters">
      <input type="search" class="form-control q flex-grow-2" placeholder="Search…">
      <select class="form-select f-cat"><option value="">All categories</option>${UI.options(Catalog.allCategories(), '')}</select>
      <select class="form-select f-status"><option value="active">Available</option><option value="low">Low stock</option><option value="inactive">Hidden</option><option value="all">All</option></select>
    </div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="list-card list"></div>`);
  const draw = () => {
    const all = Catalog.allProducts();
    $el.find('.ptabs').html([['menu', '🍛 Menu items', 'مینو'], ['stock', '📦 Stock items', 'اسٹاک']].map(([k, l, u]) => `<button class="otab ${kind === k ? 'active' : ''}" data-k="${k}">${bi(l, u)}<span class="otab-n">${all.filter((p) => p.active && Catalog.kindOf(p) === k).length}</span></button>`).join(''));
    const q = $el.find('.q').val();
    const cat = $el.find('.f-cat').val() || null;
    const f = $el.find('.f-status').val();
    const list = Catalog.searchProducts(q, { limit: Infinity, categoryId: cat, includeInactive: true, kind }).filter((p) => {
      if (f === 'all') return true;
      if (f === 'inactive') return !p.active;
      if (!p.active) return false;
      if (f === 'low') return p.trackStock !== false && p.stock <= (p.minStock || 0);
      return true;
    });
    $el.find('.summary').text(`${list.length} item(s)`);
    pager($el.find('.list'), list, (p) => {
      const low = p.trackStock !== false && p.stock <= (p.minStock || 0);
      return `<button class="list-row" data-id="${esc(p.id)}">
        ${p.image ? `<img class="thumb" src="${p.image}" alt="" loading="lazy">` : `<div class="thumb fs-4">${esc(p.emoji || (kind === 'menu' ? '🍽️' : '📦'))}</div>`}
        <div class="main"><div class="title">${esc(p.name)} ${p.active ? '' : '<span class="badge text-bg-secondary">Hidden</span>'}</div>
          <div class="sub">${esc([Catalog.category(p.categoryId)?.name, kind === 'menu' ? p.station : '', p.recipe?.length ? `recipe: ${p.recipe.length} ingredient(s)` : ''].filter(Boolean).join(' · ') || '—')}</div></div>
        <div class="end">${kind === 'menu' ? `<div class="fw-semibold money">${money(p.salePrice)}</div>` : `<div class="fw-semibold money">${fmtNum(p.purchasePrice)}/${esc(p.unit)}</div>`}
          ${p.trackStock !== false ? `<div class="sub ${low ? 'text-danger fw-semibold' : ''}">${fmtQty(p.stock)} ${esc(p.unit)}</div>` : ''}</div></button>`;
    }, 60, UI.emptyState(kind === 'menu' ? 'No menu items yet' : 'No stock items yet', kind === 'menu' ? 'egg-fried' : 'box-seam',
      canEdit ? `<button class="btn btn-primary btn-sm mt-3 btn-add">Add ${kind === 'menu' ? 'menu item' : 'stock item'}</button>` : ''));
  };
  draw();
  $el.on('click', '.ptabs [data-k]', function () { kind = this.dataset.k; pref.set('productsTab', kind); draw(); });
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f-cat, .f-status', draw);
  $el.on('click', '.btn-add', async () => { if (await editProduct(null, { kind, unit: kind === 'menu' ? 'plate' : 'kg' })) draw(); });
  $el.on('click', '.btn-cats', async () => { await manageCategories(); renderList(el); });
  $el.on('click', '.list-row[data-id]', async function () {
    const p = Catalog.product(this.dataset.id);
    if (!canEdit) { if (p.trackStock !== false) location.hash = `#/stock/${encodeURIComponent(p.id)}`; return; }
    productActions(p, draw);
  });
}

async function productActions(p, redraw) {
  const menu = Catalog.kindOf(p) === 'menu';
  const cost = menu && p.recipe?.length ? p.recipe.reduce((s, r) => s + (Catalog.product(r.productId)?.purchasePrice || 0) * r.qty, 0) : p.purchasePrice || 0;
  const m = UI.modal({ title: p.name, fullscreenMobile: false,
    body: `<div class="row small mb-3">
        ${menu ? `<div class="col-6">Price: <b>${money(p.salePrice)}</b></div>` : ''}<div class="col-6">Cost: <b>${money(cost)}</b></div>
        ${menu && p.salePrice ? `<div class="col-6">Profit: <b>${money(p.salePrice - cost)}</b> (${fmtNum(((p.salePrice - cost) / p.salePrice) * 100)}%)</div>` : ''}
        ${p.trackStock !== false ? `<div class="col-6">Stock: <b>${fmtQty(p.stock)} ${esc(p.unit)}</b></div>` : ''}
        ${p.recipe?.length ? `<div class="col-12 mt-2">Recipe: ${p.recipe.map((r) => { const i = Catalog.product(r.productId); return `${fmtQty(r.qty)} ${esc(i?.unit || '')} ${esc(i?.name || '?')}`; }).join(', ')}</div>` : ''}</div>
      <div class="d-grid gap-2">
        <button class="btn btn-primary btn-edit"><i class="bi bi-pencil me-1"></i>Edit</button>
        ${p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/${encodeURIComponent(p.id)}"><i class="bi bi-clock-history me-1"></i>Stock history</a>` : ''}
        ${Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-sliders me-1"></i>Count / wastage</a>` : ''}
        ${Auth.can('product.delete') ? '<button class="btn btn-outline-danger btn-del"><i class="bi bi-trash me-1"></i>Delete</button>' : ''}
      </div>` });
  m.$el.find('a').on('click', () => m.close());
  m.$el.find('.btn-edit').on('click', async () => { m.close(); await m.closed; if (await editProduct(p)) redraw(); });
  m.$el.find('.btn-del').on('click', async () => {
    m.close(); await m.closed;
    if (!await UI.confirmDialog(`Delete "${p.name}"? Items already sold are hidden instead.`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { const r = await Posting.deleteProduct(p.id); UI.toast(r === 'deleted' ? 'Deleted' : 'Hidden (has sales history)'); redraw(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { await renderList(el); },
};
