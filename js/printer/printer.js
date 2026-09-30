// Printing: Web Bluetooth (BLE ESC/POS printers), RawBT (Android app bridge for Classic-Bluetooth printers)
// and the browser print dialog as a universal fallback.
import { getSettings, saveSettings } from '../core/settings.js';
import { AppError, esc } from '../core/utils.js';
import * as UI from '../core/ui.js';
import { buildReceipt, toEscPos, toHTML, kotEscPos, kotHTML, orderBillModel } from './receipt.js';
import { EscPos } from './escpos.js';
import * as Raster from './raster.js';
import { ensureFont, isRTL } from './raster.js';

// Known ESC/POS BLE printer channels: [service, write characteristic]. Every service the app touches must be
// listed in optionalServices, otherwise the browser throws SecurityError even after connecting.
const KNOWN_CHANNELS = [
  ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
  ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
  ['0000ff00-0000-1000-8000-00805f9b34fb', '0000ff02-0000-1000-8000-00805f9b34fb'],
  ['0000ae30-0000-1000-8000-00805f9b34fb', '0000ae01-0000-1000-8000-00805f9b34fb'],
  ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
  ['0000fee7-0000-1000-8000-00805f9b34fb', '0000fec7-0000-1000-8000-00805f9b34fb'],
];
const BLE_SERVICES = [...new Set(KNOWN_CHANNELS.map(([svc]) => svc))];
export const CHUNK_SIZES = { 20: 'Safe — 20 bytes (most printers)', 100: 'Fast — 100 bytes', 180: 'Very fast — 180 bytes' };

let device = null;
let characteristic = null;
let queue = Promise.resolve(); // serialises print jobs so two receipts never interleave

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Web Bluetooth error names → messages a cashier can act on.
function bleError(e, action = 'connect to the printer') {
  switch (e?.name) {
    case 'NotFoundError': return new AppError('No printer selected, or no Bluetooth device was found.');
    case 'SecurityError': return new AppError('Bluetooth access was blocked. Use HTTPS and allow Bluetooth for this site.');
    case 'NetworkError': return new AppError(`Could not ${action}: the printer is off, out of range or the connection dropped.`);
    case 'NotSupportedError': return new AppError('This printer does not support the required Bluetooth operation. It may not be an ESC/POS BLE printer.');
    case 'InvalidStateError': return new AppError('Bluetooth was busy. Tap the button again.');
    case 'NotAllowedError': return new AppError('Bluetooth permission was denied.');
    default: return e instanceof AppError ? e : new AppError(e?.message || String(e));
  }
}

export function capabilities() {
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    webBluetooth: !!navigator.bluetooth && window.isSecureContext,
    android, ios,
    note: navigator.bluetooth
      ? (window.isSecureContext ? 'Web Bluetooth is available. Works with BLE (Bluetooth Low Energy) ESC/POS printers.' : 'Web Bluetooth requires HTTPS.')
      : ios ? 'No browser on iPhone/iPad supports Web Bluetooth (an Apple platform restriction). Use the browser print option (AirPrint).'
        : 'This browser does not support Web Bluetooth (Safari and Firefox do not). Use Chrome or Edge on Android, Windows, macOS, Linux or ChromeOS, or use browser print / RawBT (Android).',
  };
}

export const isConnected = () => !!(device?.gatt?.connected && characteristic);
export const connectedName = () => (isConnected() ? device.name || 'Bluetooth printer' : '');

async function findWritable(server) {
  // 1) Known printer service/characteristic pairs.
  for (const [svcId, charId] of KNOWN_CHANNELS) {
    try {
      const c = await (await server.getPrimaryService(svcId)).getCharacteristic(charId);
      if (c.properties.write || c.properties.writeWithoutResponse) return c;
    } catch { /* not present on this printer */ }
  }
  // 2) Blind discovery across the declared services.
  let services = [];
  try { services = await server.getPrimaryServices(); } catch { /* none accessible */ }
  for (const svc of services) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch { continue; }
    const c = chars.find((x) => x.properties.write) || chars.find((x) => x.properties.writeWithoutResponse);
    if (c) return c;
  }
  throw new AppError('No printer write channel found on this device. It may not be an ESC/POS BLE printer.');
}

function onDisconnected() {
  characteristic = null;
  document.dispatchEvent(new CustomEvent('printer:changed'));
}

// Connect with retries: the first gatt.connect() right after page load often fails on Android.
async function attach(dev, attempts = 3) {
  if (device !== dev) {
    device?.removeEventListener('gattserverdisconnected', onDisconnected);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
  }
  device = dev;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
      characteristic = await findWritable(server);
      saveSettings({ printer: { deviceName: dev.name || 'Bluetooth printer', deviceId: dev.id } });
      document.dispatchEvent(new CustomEvent('printer:changed'));
      return;
    } catch (e) {
      lastErr = e;
      if (e instanceof AppError) break; // wrong device type; retrying won't help
      await wait(400 * (i + 1));
    }
  }
  throw bleError(lastErr);
}

// Must be called from a real click/tap (the browser shows its device picker).
export async function connectBluetooth() {
  const cap = capabilities();
  if (!cap.webBluetooth) throw new AppError(cap.note);
  let dev;
  try {
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  } catch (e) { throw bleError(e); }
  await attach(dev);
  return dev.name;
}

// Wait until a remembered device advertises again (feature-detected; last-resort reconnect).
async function waitForAdvertisement(dev, ms = 6000) {
  if (!dev.watchAdvertisements) return false;
  const ctrl = new AbortController();
  try {
    const seen = new Promise((res) => dev.addEventListener('advertisementreceived', () => res(true), { once: true }));
    await dev.watchAdvertisements({ signal: ctrl.signal });
    return await Promise.race([seen, wait(ms).then(() => false)]);
  } catch { return false; } finally { ctrl.abort(); }
}

// Reconnect without the picker: same page session, or a device previously granted to this origin (getDevices()).
export async function reconnect() {
  if (isConnected()) return true;
  let dev = device;
  const id = getSettings().printer.deviceId;
  if (!dev && id && navigator.bluetooth?.getDevices) {
    try { dev = (await navigator.bluetooth.getDevices()).find((x) => x.id === id) || null; } catch { dev = null; }
  }
  if (!dev) return false;
  try { await attach(dev); return true; } catch (e) { console.warn('Printer reconnect failed:', e); }
  if (await waitForAdvertisement(dev)) {
    try { await attach(dev, 2); return true; } catch (e) { console.warn('Printer reconnect after advertisement failed:', e); }
  }
  return false;
}

export function disconnect() {
  try { device?.gatt?.disconnect(); } catch { /* ignore */ }
  device?.removeEventListener('gattserverdisconnected', onDisconnected);
  device = null; characteristic = null;
  saveSettings({ printer: { deviceName: '', deviceId: '' } });
  document.dispatchEvent(new CustomEvent('printer:changed'));
}

// Chunked writes: cheap BLE printers have tiny buffers, so default to 20-byte chunks with a short pause.
// Acknowledged writes (writeValueWithResponse) are preferred when the printer supports them.
async function writeBytes(bytes) {
  if (!isConnected() && !(await reconnect())) throw new AppError('Bluetooth printer is not connected. Connect it in Settings → Printer.');
  const c = characteristic;
  const withResponse = c.properties.write;
  const size = Number(getSettings().printer.chunkSize) || 20;
  // Acknowledged writes are paced by the printer itself; unacknowledged ones need a pause so its buffer can drain.
  const pause = Math.max(10, Math.round(size / 2));
  try {
    for (let i = 0; i < bytes.length; i += size) {
      const chunk = bytes.slice(i, i + size);
      if (withResponse) await (c.writeValueWithResponse ? c.writeValueWithResponse(chunk) : c.writeValue(chunk));
      else { await c.writeValueWithoutResponse(chunk); await wait(pause); }
    }
  } catch (e) { throw bleError(e, 'print'); }
}

const enqueue = (job) => { const run = queue.then(job, job); queue = run.catch(() => {}); return run; };

function rawbt(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  window.location.href = `intent:base64,${b64}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
}

export function printHTML(html, { page = 'auto', width = null } = {}) {
  const area = document.getElementById('print-area');
  area.innerHTML = html;
  const style = document.createElement('style');
  style.id = 'print-page-style';
  style.textContent = width ? `@page { size: ${width}mm auto; margin: 2mm; }` : `@page { size: ${page}; margin: 10mm; }`;
  document.head.appendChild(style);
  const cleanup = () => { area.innerHTML = ''; style.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  // The print area is hidden on screen, so the browser won't fetch the Urdu font by itself: load it first.
  const fontReady = isRTL(area.textContent) ? ensureFont() : Promise.resolve();
  Promise.race([fontReady, new Promise((r) => setTimeout(r, 4000))]).then(() => setTimeout(() => window.print(), 50));
}

async function output(bytesFn, htmlFn, width) {
  const method = getSettings().printer.method;
  if (method === 'bluetooth') return enqueue(async () => writeBytes(await bytesFn()));
  if (method === 'rawbt') return rawbt(await bytesFn());
  return printHTML(htmlFn(), { width });
}

// Print a document receipt. Falls back to the browser dialog if the chosen printer fails.
export async function printDocument(kind, doc, { silentFail = false } = {}) {
  const { width, copies } = getSettings().printer;
  const model = await buildReceipt(kind, doc);
  try {
    for (let i = 0; i < Math.max(1, Math.min(5, copies || 1)); i++) await output(() => toEscPos(model, width), () => toHTML(model, width), width);
  } catch (e) {
    if (silentFail) { UI.toast(`Print failed: ${e.message}`, 'warning', 5000); return false; }
    if (await UI.confirmDialog(`${e.message}\n\nPrint using the browser print dialog instead?`, { okLabel: 'Browser print' })) {
      printHTML(toHTML(model, width), { width });
    }
    return false;
  }
  return true;
}

// Kitchen tickets. Browser printing puts all tickets in one print job (one per page).
export async function printKots(kots, { silentFail = true } = {}) {
  if (!kots?.length) return true;
  const { width, method } = getSettings().printer;
  try {
    if (method === 'browser') printHTML(kots.map((k) => kotHTML(k, width)).join('<div style="break-after:page"></div>'), { width });
    else for (const k of kots) await output(() => kotEscPos(k, width), () => kotHTML(k, width), width);
    return true;
  } catch (e) {
    if (silentFail) { UI.toast(`Kitchen ticket not printed: ${e.message}`, 'warning', 5000); return false; }
    throw e;
  }
}

// Unpaid bill for a running order (shown to the guests before they pay).
export async function printOrderBill(order, totals) {
  const { width } = getSettings().printer;
  const model = orderBillModel(order, totals);
  try { await output(() => toEscPos(model, width), () => toHTML(model, width), width); } catch (e) {
    if (await UI.confirmDialog(`${e.message}

Print using the browser print dialog instead?`, { okLabel: 'Browser print' })) printHTML(toHTML(model, width), { width });
  }
}

const URDU_SAMPLE = 'اردو ٹیسٹ — خریداری کا شکریہ';

// Test print includes Urdu lines, so image printing (used for Urdu) can be checked too.
export async function testPrint() {
  const s = getSettings();
  const bytes = async () => {
    const fontOk = await ensureFont();
    const p = new EscPos(s.printer.width, Raster, { imageMode: s.printer.imageMode });
    p.align('center').bold(true).size(true).line('TEST PRINT').size(false).bold(false)
      .line(s.business.name).hr().align('left').lr('Paper width', s.printer.width + 'mm').lr('Columns', String(p.cols))
      .lr('Method', s.printer.method).lr('Urdu images', s.printer.imageMode === 'escstar' ? 'ESC *' : 'GS v 0')
      .lr('Urdu font', fontOk ? 'Jameel Noori' : 'fallback').line('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ').hr()
      .align('center').line(URDU_SAMPLE).align('left').lr('Customer:', 'محمد علی').hr()
      .align('center').line('Printer OK').feed(3).cut();
    return p.bytes();
  };
  const html = `<div class="receipt w${s.printer.width}"><div class="c b big">TEST PRINT</div><div class="c">${esc(s.business.name)}</div><hr><div>Paper width: ${s.printer.width}mm</div><div>Method: ${s.printer.method}</div><hr><div class="c"><span class="ur" dir="auto">${URDU_SAMPLE}</span></div><hr><div class="c">Printer OK</div></div>`;
  await output(bytes, () => html, s.printer.width);
}

