// IndexedDB schema definition and migrations.
import { CONFIG } from '../config.js';

export const DB_NAME = `${CONFIG.APP_ID}_pos`;
// Database name used by older builds (shared with other apps on the same origin). Never modified; only read on import.
export const LEGACY_DB_NAME = 'saleapp_pos';
export const DB_VERSION = 2;

// Stores that make up the business data (included in backups).
export const DATA_STORES = [
  'categories', 'products', 'customers', 'suppliers', 'accounts',
  'sales', 'saleItems', 'purchases', 'purchaseItems', 'saleReturns', 'purchaseReturns',
  'vouchers', 'entries', 'stockMoves', 'adjustments', 'holds', 'auditLog', 'meta',
  'tables', 'orders', 'kots', 'staff',
];

const STORES = {
  meta: { keyPath: 'key', indexes: {} },
  categories: { indexes: { nameLc: 'nameLc' } },
  products: { indexes: { nameLc: 'nameLc', barcode: 'barcode', sku: 'sku', categoryId: 'categoryId' } },
  customers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  suppliers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  accounts: { indexes: { type: 'type' } },
  sales: { indexes: { number: ['number', true], date: 'date', customerId: 'customerId' } },
  saleItems: { indexes: { saleId: 'saleId', productId: 'productId', date: 'date' } },
  purchases: { indexes: { number: ['number', true], date: 'date', supplierId: 'supplierId' } },
  purchaseItems: { indexes: { purchaseId: 'purchaseId', productId: 'productId', date: 'date' } },
  saleReturns: { indexes: { number: ['number', true], date: 'date', saleId: 'saleId', customerId: 'customerId' } },
  purchaseReturns: { indexes: { number: ['number', true], date: 'date', purchaseId: 'purchaseId', supplierId: 'supplierId' } },
  vouchers: { indexes: { number: ['number', true], date: 'date', type: 'type' } },
  entries: { indexes: { accountId: 'accountId', txnId: 'txnId', date: 'date', acctDate: [['accountId', 'date'], false] } },
  stockMoves: { indexes: { productId: 'productId', refId: 'refId', date: 'date', prodDate: [['productId', 'date'], false] } },
  adjustments: { indexes: { number: ['number', true], date: 'date' } },
  holds: { indexes: { createdAt: 'createdAt' } },
  auditLog: { indexes: { at: 'at' } },
};

// Added in version 2 (restaurant): dining tables, running orders, kitchen order tickets, staff.
const STORES_V2 = {
  tables: { indexes: {} },
  orders: { indexes: { number: ['number', true], status: 'status', date: 'date' } },
  kots: { indexes: { number: ['number', true], orderId: 'orderId', status: 'status', date: 'date' } },
  staff: { indexes: { nameLc: 'nameLc' } },
};

export const SYSTEM_ACCOUNTS = [
  { id: 'cash', name: 'Cash in Hand', type: 'cash' },
  { id: 'sales', name: 'Sales', type: 'income' },
  { id: 'sales_returns', name: 'Sales Returns', type: 'income' },
  { id: 'purchases', name: 'Purchases', type: 'expense' },
  { id: 'purchase_returns', name: 'Purchase Returns', type: 'expense' },
  { id: 'tax', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'equity', name: 'Opening Balance Equity', type: 'equity' },
  { id: 'income', name: 'Other Income', type: 'income' },
  { id: 'expense', name: 'General Expenses', type: 'expense' },
  { id: 'charges', name: 'Delivery & Service Charges', type: 'income' },
  { id: 'salaries', name: 'Staff Salaries', type: 'expense' },
];

// Everyday restaurant expense heads (ordinary accounts: can be renamed or removed).
export const DEFAULT_EXPENSES = [
  ['exp_gas', 'Gas', '🔥'], ['exp_electricity', 'Electricity', '💡'], ['exp_rent', 'Rent', '🏠'],
  ['exp_market', 'Vegetables & Market', '🥬'], ['exp_water', 'Water', '💧'], ['exp_packing', 'Packing & Disposables', '🥡'],
  ['exp_fuel', 'Fuel & Transport', '⛽'], ['exp_repair', 'Repairs & Maintenance', '🔧'], ['exp_cleaning', 'Cleaning', '🧹'],
];

function createStores(db, defs) {
  for (const [name, def] of Object.entries(defs)) {
    const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
    for (const [idx, spec] of Object.entries(def.indexes)) {
      const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
      os.createIndex(idx, keyPath, { unique: !!unique });
    }
  }
}

export function upgrade(db, oldVersion, t) {
  const now = new Date().toISOString();
  const acc = () => t.objectStore('accounts');
  if (oldVersion < 1) {
    createStores(db, STORES);
    for (const a of SYSTEM_ACCOUNTS) acc().put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now });
    t.objectStore('meta').put({ key: 'createdAt', value: now });
  }
  if (oldVersion < 2) {
    createStores(db, STORES_V2);
    for (const a of SYSTEM_ACCOUNTS) {
      const r = acc().get(a.id);
      r.onsuccess = () => { if (!r.result) acc().put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now }); };
    }
    for (const [id, name, emoji] of DEFAULT_EXPENSES) {
      const r = acc().get(id);
      r.onsuccess = () => { if (!r.result) acc().put({ id, name, emoji, type: 'expense', system: false, active: 1, openingBalance: 0, createdAt: now, updatedAt: now }); };
    }
    t.objectStore('meta').put({ key: 'schemaVersion', value: 2 });
  }
  // Future migrations: if (oldVersion < 3) { ... }
}
