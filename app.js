// Recall Watch — food recall tracker for anyone who cooks for other people.
// The idea started in a church soup kitchen.
// Everything you enter stays on this phone (IndexedDB). Contact lists are
// never stored in this app.
import { findMatches, STATES, itemKeyword } from './lib/match.js';
import { seal } from './vendor/sealbox.js';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmt = s => { if (!s) return ''; const d = new Date(String(s).length === 10 ? s + 'T12:00:00' : s); return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const daysAgo = s => Math.floor((Date.now() - new Date(s + 'T12:00:00')) / 86400000);
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
const LEVEL_TEXT = { confirmed: 'Confirmed match', likely: 'Likely match', fyi: 'FYI – same food, other brand' };
const ALLERGENS = ['Milk', 'Egg', 'Wheat', 'Soy', 'Peanut', 'Tree nut', 'Fish', 'Shellfish', 'Sesame'];
const CATEGORIES = ['Meat & poultry', 'Eggs', 'Dairy', 'Fresh produce', 'Frozen vegetables', 'Canned goods', 'Dry goods & pasta', 'Spices & seasonings', 'Broth & stock', 'Bread & bakery', 'Other'];
const HIGH_RISK = new Set(['Meat & poultry', 'Eggs', 'Dairy', 'Fresh produce', 'Frozen vegetables', 'Spices & seasonings']);

// ---------- storage (IndexedDB) ----------
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('recallwatch', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('photos'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(store, mode); const req = fn(tx.objectStore(store)); tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); });
}
const getKV = k => idb('kv', 'readonly', s => s.get(k));
const setKV = (k, v) => idb('kv', 'readwrite', s => s.put(v, k));
const putPhoto = (id, blob) => idb('photos', 'readwrite', s => s.put(blob, id));
const getPhoto = id => idb('photos', 'readonly', s => s.get(id));
const delPhoto = id => idb('photos', 'readwrite', s => s.delete(id));

const DEFAULT = {
  settings: { state: '', stores: [], kitchenName: '', contactNumber: '', notify: ['confirmed', 'likely'], keepDays: 60, checkEveryHours: 12, ghRepo: '', ghToken: '', setupDone: false },
  trips: [], items: [], batches: [], alertState: {}, lastSync: '', lastBackup: '',
};
let S; // app state
async function load() {
  S = (await getKV('state')) || structuredClone(DEFAULT);
  S.settings = { ...DEFAULT.settings, ...S.settings };
  for (const k of Object.keys(DEFAULT)) if (S[k] === undefined) S[k] = structuredClone(DEFAULT[k]);
  if (S.settings.state && S.items.length) S.settings.setupDone = true;
}

// Automatic clean-up: anything older than "keep days" is deleted from this phone —
// items (with barcodes, lot codes, label photos), shopping trips and receipt photos,
// and meal records.
async function purgeOld() {
  const keep = Number(S.settings.keepDays) || 60;
  const old = d => d && daysAgo(d) > keep;
  const goneItems = S.items.filter(i => old(i.purchased));
  const goneTrips = S.trips.filter(t => old(t.date));
  const goneMeals = S.batches.filter(b => old(b.served));
  if (!goneItems.length && !goneTrips.length && !goneMeals.length) return 0;
  const ids = new Set(goneItems.map(i => i.id));
  for (const i of goneItems) if (i.photoId) await delPhoto(i.photoId);
  for (const t of goneTrips) if (t.receiptId) await delPhoto(t.receiptId);
  S.items = S.items.filter(i => !ids.has(i.id));
  S.trips = S.trips.filter(t => !old(t.date)).map(t => ({ ...t, itemIds: t.itemIds.filter(x => !ids.has(x)) }));
  S.batches = S.batches.filter(b => !old(b.served)).map(b => ({ ...b, itemIds: b.itemIds.filter(x => !ids.has(x)) }));
  for (const [k, v] of Object.entries(S.alertState)) if (v.updated && daysAgo(v.updated.slice(0, 10)) > keep) delete S.alertState[k];
  await save({ sync: true });
  return goneItems.length + goneTrips.length + goneMeals.length;
}
let saveTimer;
async function save({ sync = false } = {}) {
  await setKV('state', S);
  if (sync && S.settings.ghToken) { clearTimeout(saveTimer); saveTimer = setTimeout(() => syncWatchlist(true), 2500); }
}
const itemById = id => S.items.find(i => i.id === id);

// ---------- images ----------
async function shrink(file, max = 1600, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', q));
  } finally { URL.revokeObjectURL(url); }
}
async function photoTag(id, alt = 'photo') {
  if (!id) return '';
  const b = await getPhoto(id); if (!b) return '';
  return `<img class="thumb" alt="${esc(alt)}" src="${URL.createObjectURL(b)}">`;
}
function pickImage() {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.capture = 'environment';
    i.onchange = () => res(i.files[0] || null); i.click();
  });
}

// ---------- recall data ----------
let RECALLS = null, RECALL_META = null;
async function loadRecalls(force = false) {
  if (RECALLS && !force) return;
  try {
    const r = await fetch('data/recalls.json', { cache: 'no-cache' });
    const j = await r.json();
    RECALLS = j.recalls || []; RECALL_META = j;
    await setKV('recalls', j);
  } catch {
    const j = await getKV('recalls'); RECALLS = j?.recalls || []; RECALL_META = j || {};
    RECALL_META.offline = true;
  }
}
function matches() {
  return findMatches(RECALLS || [], S.items, S.settings, { lookbackDays: Number(S.settings.keepDays) || 60 });
}
function openMatches() {
  return matches().filter(m => !['resolved', 'not-ours'].includes(S.alertState[m.recall.id]?.status));
}
function updateBadge() {
  const n = openMatches().filter(m => m.level !== 'fyi').length;
  const b = $('#badge'); b.hidden = !n; b.textContent = n;
}

// ---------- router ----------
const routes = {};
let currentTab = 'alerts';
async function route() {
  const [name = 'alerts', ...args] = (location.hash.slice(1) || 'alerts').split('/');
  const fn = routes[name] || routes.alerts;
  const tab = fn.tab || name;
  currentTab = tab;
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  $('#backBtn').hidden = !fn.back;
  window.scrollTo(0, 0);
  try { await fn(...args.map(decodeURIComponent)); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="notice bad">Something went wrong: ${esc(e.message)}</div>`; }
  updateBadge();
}
function view(title, html) { $('#title').textContent = title; $('#view').innerHTML = html; }
$('#backBtn').onclick = () => history.length > 1 ? history.back() : (location.hash = currentTab);
window.addEventListener('hashchange', route);

// ---------- ALERTS ----------
routes.alerts = async function () {
  view('Recall alerts', `<p class="muted"><span class="spinner"></span> Checking recalls…</p>`);
  await loadRecalls(true);
  const all = matches();
  const open = all.filter(m => !['resolved', 'not-ours'].includes(S.alertState[m.recall.id]?.status));
  const serious = open.filter(m => m.level !== 'fyi'), fyi = open.filter(m => m.level === 'fyi');
  const closed = all.filter(m => ['resolved', 'not-ours'].includes(S.alertState[m.recall.id]?.status));
  const meta = RECALL_META || {};
  const bad = Object.entries(meta.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  const card = m => `<a class="card ${m.level}" href="#alert/${encodeURIComponent(m.recall.id)}">
      <span class="pill ${m.level}">${LEVEL_TEXT[m.level]}</span><span class="pill teal">${esc(m.region)}</span>
      <h3>${esc(m.recall.title)}</h3>
      <p class="muted small">Your item: ${esc(m.hits.map(h => h.itemName).join(', '))} · ${esc(fmt(m.recall.date))}</p></a>`;
  let html = '';
  if (!S.items.length) html += `<div class="notice">Welcome! Start by logging a shopping trip on the <a href="#shop">Shopping</a> tab. Recall Watch then checks every purchase against FDA and USDA recalls for ${esc(STATES[S.settings.state] || S.settings.state)} and your stores. New here? See <a href="#help">How to use</a>.</div>`;
  html += serious.length ? `<h2>Needs your attention (${serious.length})</h2>${serious.map(card).join('')}`
    : `<div class="card ok"><span class="pill ok">All clear</span><h3>No recalls match your items</h3><p class="muted small">Checked ${(RECALLS || []).length} recent recalls against ${S.items.length} items.</p></div>`;
  if (fyi.length) html += `<details><summary>FYI: same kind of food, different brand (${fyi.length})</summary><p class="muted small">These recalls mention a food you bought, but not your brand or barcode. Usually nothing to do — open one if you're unsure.</p>${fyi.map(card).join('')}</details>`;
  if (closed.length) html += `<details><summary>Handled (${closed.length})</summary>${closed.map(card).join('')}</details>`;
  html += `<p class="muted small" style="margin-top:18px">Recall data updated ${meta.updated ? esc(new Date(meta.updated).toLocaleString()) : 'not yet — see More › Phone alerts setup'}${meta.offline ? ' (offline copy)' : ''}.
    ${bad.length ? `<br>⚠️ Couldn't reach: ${esc(bad.join(', '))} on the last check. It will try again automatically.` : ''}
    <br>Many stores (Kroger, BJ's, Costco, Sam's Club and others) also email or call shoppers about recalls tied to their loyalty card or membership.</p>`;
  view('Recall alerts', html);
};

routes.alert = async function (id) {
  await loadRecalls();
  const m = matches().find(x => x.recall.id === id);
  if (!m) return view('Alert', `<div class="empty">This recall no longer matches any of your items.</div>`);
  const r = m.recall, st = S.alertState[id] ||= { status: 'new', checks: {}, notes: '' };
  const itemIds = m.hits.map(h => h.itemId);
  const batches = S.batches.filter(b => b.itemIds.some(i => itemIds.includes(i))).sort((a, b) => b.served.localeCompare(a.served));
  const steps = [
    ['find', 'Find the item(s) below in the pantry, fridge, or freezer.'],
    ['compare', 'Compare the package to the recall: brand, size, UPC, lot code, and best-by date.'],
    ['pull', 'If it matches (or you can\'t tell): pull it, bag it, and label it "RECALLED – DO NOT USE".'],
    ['clean', 'Wash and sanitize any shelf, bin, or surface it touched.'],
    ['follow', 'Follow the recall notice for return or disposal (stores usually give refunds with the receipt).'],
    ['guests', 'If it went into a meal you served, decide whether to tell the people who ate it (button below).'],
    ['record', 'Write down what you did in the notes box.'],
  ];
  const itemRows = m.hits.map(h => { const it = itemById(h.itemId); return `<a class="list-item" href="#item/${it.id}"><div><b>${esc(h.itemName)}</b><br>
      <span class="pill ${h.level}">${h.level}</span><span class="muted small">${esc(h.why.join('; '))}</span><br>
      <span class="muted small">Bought ${esc(fmt(it.purchased))} at ${esc(it.store || '?')}${it.lot ? ' · lot ' + esc(it.lot) : ''}${it.bestBy ? ' · best by ' + esc(fmt(it.bestBy)) : ''} · status: ${esc(it.status)}</span></div><span class="chev">›</span></a>`; }).join('');
  view('Recall details', `
    <span class="pill ${m.level}">${LEVEL_TEXT[m.level]}</span><span class="pill teal">${esc(m.region)}</span>${r.classification ? `<span class="pill gray">${esc(r.classification)}</span>` : ''}
    <h2>${esc(r.title)}</h2>
    <dl class="kv">
      <dt>Reason</dt><dd>${esc(r.reason || '—')}</dd>
      ${r.firm ? `<dt>Company</dt><dd>${esc(r.firm)}</dd>` : ''}
      ${r.product && r.product !== r.title ? `<dt>Product</dt><dd>${esc(r.product)}</dd>` : ''}
      ${r.codes ? `<dt>Codes / lots</dt><dd>${esc(r.codes)}</dd>` : ''}
      <dt>Sold in</dt><dd>${esc(r.distribution || 'Not listed — check the notice')}</dd>
      <dt>Date</dt><dd>${esc(fmt(r.date))}</dd>
      <dt>Source</dt><dd>${esc(r.source)}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">open notice</a>` : ''}</dd>
    </dl>
    <h2>Your matching items</h2><div class="card">${itemRows}</div>
    <h2>Meals served with these items</h2>
    <div class="card">${batches.length ? batches.map(b => `<a class="list-item" href="#batch/${b.id}"><div><b>${esc(b.name)}</b><br><span class="muted small">Served ${esc(fmt(b.served))}${b.servings ? ` · about ${b.servings} servings` : ''}</span></div><span class="chev">›</span></a>`).join('') : '<p class="muted">None of these items are logged in a meal.</p>'}</div>
    <h2>What to do</h2>
    <div class="card">${steps.map(([k, t]) => `<label class="check"><input type="checkbox" data-step="${k}" ${st.checks[k] ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}</div>
    <label for="notes">Notes</label><textarea id="notes" style="min-height:100px" placeholder="e.g. Checked lot code – not ours. / Pulled 2 bags, returned to Kroger 11/24.">${esc(st.notes)}</textarea>
    ${batches.length ? `<a class="btn block" href="#message/${encodeURIComponent(id)}">✉️ Draft a message to people you served</a>` : ''}
    <div class="row"><button class="btn secondary" id="notOurs">Not ours</button><button class="btn" id="resolved">Mark handled</button></div>
    ${['resolved', 'not-ours'].includes(st.status) ? `<button class="btn block secondary" id="reopen">Reopen this alert</button>` : ''}
    <p class="muted small">Recall information is copied from FDA and USDA. Always confirm details on the official notice.</p>`);
  const persist = () => { st.notes = $('#notes').value; st.updated = new Date().toISOString(); save(); };
  $$('[data-step]').forEach(c => c.onchange = () => { st.checks[c.dataset.step] = c.checked; if (st.status === 'new') st.status = 'checking'; persist(); });
  $('#notes').onchange = persist;
  $('#notOurs').onclick = () => { st.status = 'not-ours'; persist(); toast('Marked "not ours"'); location.hash = 'alerts'; };
  $('#resolved').onclick = () => { st.status = 'resolved'; persist(); toast('Marked handled'); location.hash = 'alerts'; };
  if ($('#reopen')) $('#reopen').onclick = () => { st.status = 'checking'; persist(); route(); };
};
routes.alert.back = true; routes.alert.tab = 'alerts';

routes.message = async function (id) {
  await loadRecalls();
  const m = matches().find(x => x.recall.id === id);
  if (!m) return view('Message to people you served', `<div class="empty">Recall not found.</div>`);
  const itemIds = m.hits.map(h => h.itemId);
  const batches = S.batches.filter(b => b.itemIds.some(i => itemIds.includes(i))).sort((a, b) => a.served.localeCompare(b.served));
  const dates = batches.map(b => new Date(b.served + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
  const dateText = dates.length > 1 ? dates.slice(0, -1).join(', ') + ' or ' + dates.at(-1) : dates[0] || '[date]';
  const product = m.hits.map(h => h.itemName).join(' and ');
  const allergen = /undeclared|allerg/i.test(m.recall.reason || '');
  const reason = (m.recall.reason || '').split(/[.;]/)[0].trim().replace(/^(the |this )?(product|firm|company)( is| was)? (being )?recalled (because|due to|for)( of)?\s*/i, '') || 'a safety concern';
  const reasonText = reason.charAt(0).toLowerCase() + reason.slice(1);
  const k = S.settings.kitchenName, phone = S.settings.contactNumber;
  const head = k ? `${k} – food safety notice:` : 'Food safety notice:';
  const msg = allergen
    ? `${head} The meal served on ${dateText} may have included ${product}, which has been recalled because of ${reasonText}. If you have a food allergy and ate the meal, watch for allergy symptoms and contact a doctor if you feel unwell. If you have leftovers, please throw them away.${phone ? ` Questions? Call or text ${phone}.` : ''} We're sorry for the worry, and thank you for understanding.`
    : `${head} The meal served on ${dateText} may have included ${product}, which has been recalled because of ${reasonText}. If you have any leftovers, please throw them away. If you ate it and feel sick (for example fever, stomach pain, vomiting, or diarrhea), please contact a doctor and mention this recall.${phone ? ` Questions? Call or text ${phone}.` : ''} We're sorry for the worry, and thank you for understanding.`;
  view('Message to people you served', `
    <div class="notice">This app doesn't keep anyone's phone numbers. Copy this message and send it from your own phone to the people who ate the meal. For a larger group, also post or hand out a printed copy for anyone you can't reach by phone.</div>
    <label for="msg">Message <span class="muted">(edit as needed)</span></label>
    <textarea id="msg">${esc(msg)}</textarea>
    <p class="muted small" id="len"></p>
    <div class="row"><button class="btn" id="copy">📋 Copy</button>${navigator.share ? '<button class="btn secondary" id="share">Share…</button>' : ''}</div>
    <button class="btn block secondary" id="print">🖨️ Print notice</button>
    <details><summary>Tips for sending</summary><ul class="small">
      <li>Send each text one at a time from your phone's normal messaging app, so replies come back to you privately.</li>
      <li>Avoid sending the same text to dozens of people from Google Voice in a few minutes — it may block your number for a day.</li>
      <li>Have someone read it over before sending if you can.</li></ul></details>`);
  const upd = () => { const n = $('#msg').value.length; $('#len').textContent = `${n} characters (about ${Math.ceil(n / 153)} text segment${n > 160 ? 's' : ''})`; };
  $('#msg').oninput = upd; upd();
  $('#copy').onclick = async () => { try { await navigator.clipboard.writeText($('#msg').value); toast('Copied – paste into your text app'); } catch { $('#msg').select(); toast('Press and hold to copy'); } };
  if ($('#share')) $('#share').onclick = () => navigator.share({ text: $('#msg').value }).catch(() => {});
  $('#print').onclick = () => { const w = window.open('', '_blank'); w.document.write(`<title>Food safety notice</title><body style="font:22px/1.5 sans-serif;padding:40px;max-width:800px"><h1>Food Safety Notice</h1><p>${esc($('#msg').value)}</p></body>`); w.document.close(); w.print(); };
};
routes.message.back = true; routes.message.tab = 'alerts';

// ---------- SHOPPING ----------
routes.shop = function () {
  const trips = [...S.trips].sort((a, b) => b.date.localeCompare(a.date));
  view('Shopping trips', `
    <a class="btn block" href="#trip/new">➕ Log a shopping trip</a>
    <p class="muted small">Snap the receipt, then scan barcodes or snap lot codes for meat, eggs, dairy, produce, frozen vegetables, and spices — those are recalled most often.</p>
    <h2>Recent trips</h2>
    <div class="card">${trips.length ? trips.map(t => `<a class="list-item" href="#trip/${t.id}"><div><b>${esc(t.store)}</b> · ${esc(fmt(t.date))}<br><span class="muted small">${t.itemIds.length} item${t.itemIds.length === 1 ? '' : 's'}</span></div><span class="chev">›</span></a>`).join('') : '<div class="empty">No trips yet.</div>'}</div>`);
};

routes.trip = async function (id) {
  let t;
  if (id === 'new') {
    t = { id: uid(), date: today(), store: S.settings.stores[0] || '', itemIds: [], receiptId: '' };
    S.trips.push(t); await save(); history.replaceState(null, '', '#trip/' + t.id);
  } else t = S.trips.find(x => x.id === id);
  if (!t) return view('Trip', '<div class="empty">Trip not found.</div>');
  const items = t.itemIds.map(itemById).filter(Boolean);
  view('Shopping trip', `
    <div class="row"><div style="flex:1;min-width:140px"><label for="tdate">Date</label><input type="date" id="tdate" value="${esc(t.date)}"></div>
    <div style="flex:1;min-width:140px"><label for="tstore">Store</label><select id="tstore">${[...new Set([...S.settings.stores, t.store, 'Other'])].filter(Boolean).map(s => `<option ${s === t.store ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div></div>
    <h2>Receipt</h2>
    <div id="receipt">${t.receiptId ? await photoTag(t.receiptId, 'receipt') : '<p class="muted small">No receipt photo yet.</p>'}</div>
    <div class="row"><button class="btn secondary" id="snapReceipt">📷 ${t.receiptId ? 'Retake' : 'Photograph'} receipt</button>${t.receiptId ? '<button class="btn secondary" id="readReceipt">🔎 Read items from receipt</button>' : ''}</div>
    <div id="ocr"></div>
    <h2>Items (${items.length})</h2>
    <div class="row"><button class="btn" id="scan">▥ Scan barcode</button><button class="btn secondary" id="addManual">✏️ Type an item</button></div>
    <div class="card">${items.length ? items.map(i => `<a class="list-item" href="#item/${i.id}"><div><b>${esc([i.brand, i.name].filter(Boolean).join(' '))}</b><br><span class="muted small">${[i.category, i.upc ? 'UPC ✓' : (HIGH_RISK.has(i.category) ? '⚠️ no barcode' : ''), i.lot ? 'lot ✓' : ''].filter(Boolean).map(esc).join(' · ') || 'tap to add details'}</span></div><span class="chev">›</span></a>`).join('') : '<div class="empty">No items yet.</div>'}</div>
    <button class="btn block secondary" id="done">✔ Done</button>
    <button class="btn block danger" id="delTrip">Delete this trip</button>`);
  $('#tdate').onchange = async e => { t.date = e.target.value; items.forEach(i => i.purchased = t.date); await save({ sync: true }); };
  $('#tstore').onchange = async e => { t.store = e.target.value; items.forEach(i => i.store = t.store); await save({ sync: true }); };
  $('#snapReceipt').onclick = async () => {
    const f = await pickImage(); if (!f) return;
    toast('Saving photo…'); if (t.receiptId) await delPhoto(t.receiptId);
    t.receiptId = uid(); await putPhoto(t.receiptId, await shrink(f, 2000, 0.8)); await save(); route();
  };
  if ($('#readReceipt')) $('#readReceipt').onclick = () => readReceipt(t);
  $('#scan').onclick = () => scanBarcode(async (code, info) => { const it = newItem(t, { upc: code, name: info?.name || '', brand: info?.brand || '' }); await save({ sync: true }); location.hash = 'item/' + it.id; });
  $('#addManual').onclick = async () => { const it = newItem(t, {}); await save(); location.hash = 'item/' + it.id; };
  $('#done').onclick = () => { if (S.settings.ghToken) syncWatchlist(true); location.hash = 'shop'; };
  $('#delTrip').onclick = async () => {
    if (!confirm('Delete this trip and its items?')) return;
    for (const i of items) { S.items = S.items.filter(x => x.id !== i.id); if (i.photoId) delPhoto(i.photoId); S.batches.forEach(b => b.itemIds = b.itemIds.filter(x => x !== i.id)); }
    if (t.receiptId) delPhoto(t.receiptId);
    S.trips = S.trips.filter(x => x.id !== t.id); await save({ sync: true }); location.hash = 'shop';
  };
};
routes.trip.back = true; routes.trip.tab = 'shop';

function guessCategory(name) {
  const n = ' ' + name.toLowerCase() + ' ';
  const rules = [['Meat & poultry', /chicken|chkn|beef|\bbf\b|pork|sausage|turkey|ham\b|bacon|ground|meat|hot dog/], ['Eggs', /\begg/],
    ['Dairy', /milk|cheese|chs|cream|butter|yogurt|sour cr/], ['Frozen vegetables', /frozen|frz|froz/],
    ['Broth & stock', /broth|stock|brth|bouillon/], ['Spices & seasonings', /spice|pepper|cumin|paprika|garlic powder|onion powder|season|oregano|basil|thyme|chili powder|cinnamon|salt\b/],
    ['Canned goods', /\bcan\b|canned|tomato sauce|diced tom|beans|bns|soup\b/], ['Dry goods & pasta', /pasta|noodle|rice|flour|lentil|barley|cracker|oats/],
    ['Bread & bakery', /bread|roll|bun|bagel|tortilla/],
    ['Fresh produce', /onion|carrot|celery|potato|tomato|lettuce|spinach|cabbage|pepper|apple|banana|squash|zucchini|kale|cilantro|parsley|produce/]];
  for (const [c, re] of rules) if (re.test(n)) return c;
  return 'Other';
}
function newItem(t, f) {
  const it = { id: uid(), tripId: t.id, name: '', brand: '', upc: '', lot: '', bestBy: '', keyword: '', category: '', storeCode: '', photoId: '', store: t.store, purchased: t.date, status: 'pantry', ...f };
  if (!it.category) it.category = guessCategory(it.name || '');
  S.items.push(it); t.itemIds.push(it.id); return it;
}

// Receipt reading: on-phone text recognition (Tesseract, free, loaded on first use).
const ABBR = { kro: 'Kroger', kroger: 'Kroger', ps: 'Private Selection', st: 'Simple Truth', wf: 'Wellsley Farms', chkn: 'chicken', chk: 'chicken', brth: 'broth', bf: 'beef', grnd: 'ground', grn: 'green', bns: 'beans', tom: 'tomato', toms: 'tomatoes', onio: 'onion', onin: 'onion', crrt: 'carrot', crrts: 'carrots', pot: 'potato', pots: 'potatoes', veg: 'vegetable', vegs: 'vegetables', clry: 'celery', frz: 'frozen', chs: 'cheese', mlk: 'milk', bttr: 'butter', ndl: 'noodle', ndls: 'noodles', swt: 'sweet', org: 'organic', lg: 'large', sm: 'small', ckd: 'cooked', brst: 'breast', thgh: 'thigh', dcd: 'diced', crshd: 'crushed', sce: 'sauce', pste: 'paste', whl: 'whole', ylw: 'yellow' };
function parseReceipt(text) {
  const skip = /sub\s*total|total|tax|balance|change|cash|visa|master|debit|credit|amex|discover|savings|you saved|price you pay|coupon|fuel|points|member|card|tender|approved|auth|ref\s*#|terminal|thank|store\s*#|cashier|items sold|survey|www|\.com|phone|tel\b/i;
  const lines = [];
  for (let raw of text.split('\n')) {
    raw = raw.trim();
    const m = raw.match(/^(.*?)[\s$]+(\d{1,4}[.,]\d{2})\s*-?\s*[A-Z*]{0,3}\s*$/);
    if (!m || skip.test(raw)) continue;
    let name = m[1].replace(/^\d+\s*[@xX]\s*/, '');
    let code = '';
    const c = name.match(/^(\d{4,6})\s+(.*)$/); if (c) { code = c[1]; name = c[2]; }
    name = name.replace(/\b\d{8,14}\b/g, '').replace(/[^A-Za-z0-9 &'%/.-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.replace(/[^A-Za-z]/g, '').length < 3) continue;
    let brand = '';
    const words = name.split(' ').map(w => { const k = w.toLowerCase(); return ABBR[k] || w.toLowerCase(); });
    if (['Kroger', 'Private Selection', 'Simple Truth', 'Wellsley Farms'].includes(words[0])) brand = words.shift();
    const nice = words.join(' ').replace(/\b[a-z]/g, ch => ch.toUpperCase());
    lines.push({ name: nice, brand, storeCode: code, raw });
  }
  return lines;
}
let tessLoading;
async function ensureTesseract() {
  if (window.Tesseract) return;
  tessLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = res; s.onerror = () => { tessLoading = null; rej(new Error('Could not download the text reader. Check your internet connection.')); }; document.head.appendChild(s); });
  await tessLoading;
}

// ---- Reading lot codes and dates from a label photo ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function mkDate(y, m, d) {
  y = +y; m = +m; d = +d; if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(y, m - 1, d); if (dt.getMonth() !== m - 1) return '';
  const now = new Date(), lo = new Date(now.getFullYear() - 2, 0, 1), hi = new Date(now.getFullYear() + 6, 0, 1);
  if (dt < lo || dt > hi) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Finds dates in text; returns [{date, keyword}] with dates after "best by"/"use by"/"exp" first.
function findDates(text) {
  const t = text.toUpperCase().replace(/[|\\]/g, '/').replace(/O(?=\d)|(?<=\d)O/g, '0');
  const out = [];
  const KW = /(BEST\s*(IF\s*USED\s*)?(BY|BEFORE)|USE\s*(BY|BEFORE)|EXP(IRES|IRY|\.)?|BB|BBD|SELL\s*BY|FRESH\s*(UNTIL|THRU))\s*[:.]?\s*$/;
  const add = (iso, idx) => { if (!iso) return; const kw = KW.test(t.slice(Math.max(0, idx - 24), idx)); if (!out.some(o => o.date === iso)) out.push({ date: iso, keyword: kw }); else if (kw) out.find(o => o.date === iso).keyword = true; };
  let m;
  const mon = '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\\.?';
  const r1 = /\b(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{4}|\d{2})\b/g;           // 03/15/2028, 03 15 28
  while ((m = r1.exec(t))) add(mkDate(m[3], m[1], m[2]), m.index);
  const r2 = /\b(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/g;                // 2028-03-15
  while ((m = r2.exec(t))) add(mkDate(m[1], m[2], m[3]), m.index);
  const r3 = new RegExp('\\b' + mon + '\\s*(\\d{1,2})[,\\s]+(\\d{4}|\\d{2})\\b', 'g');  // MAR 15 2028
  while ((m = r3.exec(t))) add(mkDate(m[3], MONTHS[m[1].toLowerCase()], m[2]), m.index);
  const r4 = new RegExp('\\b(\\d{1,2})\\s*' + mon + '\\s*(\\d{4}|\\d{2})\\b', 'g');  // 15 MAR 2028, 15MAR28
  while ((m = r4.exec(t))) add(mkDate(m[3], MONTHS[m[2].toLowerCase()], m[1]), m.index);
  const r5 = new RegExp('\\b' + mon + '\\s*(\\d{4})\\b', 'g');                      // MAR 2028 (no day)
  while ((m = r5.exec(t))) { const y = +m[2], mo = MONTHS[m[1].toLowerCase()]; add(mkDate(y, mo, new Date(y, mo, 0).getDate()), m.index); }
  return out.sort((a, b) => b.keyword - a.keyword);
}
// Finds lot / batch codes. Returns {lot, candidates}.
function findLot(text, dates = [], upc = '') {
  const t = text.toUpperCase();
  const m = t.match(/\b(?:LOT|LOT\s*(?:NO|NUMBER|#)|BATCH|CODE|PROD(?:UCT)?\s*CODE)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/ ]{2,18}[A-Z0-9])/)
    || t.match(/\bL\s*[:#]?\s*(\d[A-Z0-9\-]{3,14})\b/);
  let lot = m ? m[1].trim().replace(/\s+(BEST|USE|EXP|BB|SELL).*$/, '').replace(/\s{2,}/g, ' ') : '';
  const extra = lot.split(' ').slice(1);
  lot = lot.split(' ')[0];
  const upcDigits = String(upc).replace(/\D/g, '');
  const rawCands = [...new Set((t.match(/\b[A-Z0-9][A-Z0-9\-]{3,15}\b/g) || []).filter(w =>
    /\d/.test(w) && /^[A-Z0-9-]+$/.test(w) && !/^\d{1,2}$/.test(w) && !/^(19|20)\d{2}$/.test(w) &&
    !(upcDigits && upcDigits.includes(w.replace(/\D/g, '')) && w.replace(/\D/g, '').length > 6) &&
    !/^\d+(OZ|LB|LBS|G|KG|ML|L|CT|PK)$/.test(w) && !/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(w) && w !== lot))];
  const cands = [...new Set([...extra.filter(x => x.length >= 3), ...rawCands])].filter(x => x !== lot).slice(0, 6);
  return { lot, candidates: cands };
}
async function readLabel(blob) {
  await ensureTesseract();
  // Boost contrast: printed codes on cans are often faint.
  const img = await createImageBitmap(blob);
  const k = Math.min(2, 2000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.6)'; g.drawImage(img, 0, 0, c.width, c.height);
  const { data } = await window.Tesseract.recognize(c, 'eng');
  return data.text || '';
}
async function readReceipt(t) {
  const box = $('#ocr');
  box.innerHTML = `<div class="notice"><span class="spinner"></span> Reading the receipt on your phone… the first time takes up to a minute while it downloads the reader.</div>`;
  try {
    await ensureTesseract();
    const blob = await getPhoto(t.receiptId);
    const { data } = await window.Tesseract.recognize(blob, 'eng');
    const lines = parseReceipt(data.text || '');
    if (!lines.length) { box.innerHTML = `<div class="notice warn">Couldn't find item lines. Try a straighter, closer, well-lit photo — or add items by barcode or by typing.</div>`; return; }
    box.innerHTML = `<div class="card"><h3>Check these items</h3><p class="muted small">Receipts use short names. Fix any spelling, untick anything that isn't food for the kitchen, then add.</p>
      ${lines.map((l, i) => `<div class="ocr-line"><input type="checkbox" checked data-i="${i}" aria-label="include"><input type="text" value="${esc([l.brand, l.name].filter(Boolean).join(' '))}" data-n="${i}"></div>`).join('')}
      <button class="btn block" id="addOcr">Add checked items</button></div>`;
    $('#addOcr').onclick = async () => {
      let n = 0;
      lines.forEach((l, i) => {
        if (!$(`[data-i="${i}"]`).checked) return;
        let full = $(`[data-n="${i}"]`).value.trim(); if (!full) return;
        let brand = l.brand; if (brand && full.startsWith(brand)) full = full.slice(brand.length).trim(); else brand = '';
        newItem(t, { name: full, brand, storeCode: l.storeCode }); n++;
      });
      await save({ sync: true }); toast(`Added ${n} items`); route();
    };
  } catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message || e)}</div>`; }
}

// Barcode scanning (camera) + free product lookup from Open Food Facts.
async function lookupUPC(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands`);
    const j = await r.json();
    if (j.status === 1) return { name: j.product.product_name || '', brand: (j.product.brands || '').split(',')[0].trim() };
  } catch {}
  return null;
}
function scanBarcode(onCode) {
  const modal = $('#modal');
  modal.innerHTML = `<div class="sheet"><h3>Scan barcode</h3><p class="muted small">Point the camera at the barcode and hold steady.</p><div id="reader"></div>
    <p id="scanMsg" class="muted small"></p>
    <div class="row"><button class="btn secondary" id="photoScan">📷 Use a photo instead</button><button class="btn secondary" id="typeUpc">⌨️ Type numbers</button></div>
    <button class="btn block danger" id="cancelScan">Cancel</button></div>`;
  modal.hidden = false;
  let scanner, finished = false;
  const formats = window.Html5QrcodeSupportedFormats ? [Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8] : undefined;
  const close = async () => { try { if (scanner?.isScanning) await scanner.stop(); scanner?.clear(); } catch {} modal.hidden = true; modal.innerHTML = ''; };
  const done = async code => {
    if (finished) return; finished = true;
    $('#scanMsg').innerHTML = `<span class="spinner"></span> Found ${esc(code)} – looking up product…`;
    const info = await lookupUPC(code);
    await close(); toast(info ? `Found: ${info.brand} ${info.name}` : 'Barcode saved – please type the product name');
    onCode(code, info);
  };
  try {
    scanner = new Html5Qrcode('reader', { formatsToSupport: formats, useBarCodeDetectorIfSupported: true, verbose: false });
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }) }, done, () => {})
      .catch(() => { $('#scanMsg').textContent = 'Camera not available here. Use "Use a photo instead" or type the numbers.'; });
  } catch { $('#scanMsg').textContent = 'Scanner failed to load. Use a photo or type the numbers.'; }
  $('#cancelScan').onclick = close;
  $('#photoScan').onclick = async () => {
    const f = await pickImage(); if (!f) return;
    try { if (scanner?.isScanning) await scanner.stop(); const code = await scanner.scanFile(f, false); done(code); }
    catch { $('#scanMsg').textContent = 'No barcode found in that photo. Try closer, with the barcode flat and in focus.'; }
  };
  $('#typeUpc').onclick = () => { const v = (prompt('Type the numbers under the barcode:') || '').replace(/\D/g, ''); if (v.length >= 8) done(v); };
}

// ---------- ITEM ----------
routes.item = async function (id) {
  const it = itemById(id);
  if (!it) return view('Item', '<div class="empty">Item not found.</div>');
  const batches = S.batches.filter(b => b.itemIds.includes(it.id));
  view('Item details', `
    <label for="name">Product name</label><input type="text" id="name" value="${esc(it.name)}" placeholder="e.g. Chicken Broth 32 oz">
    <label for="brand">Brand</label><input type="text" id="brand" value="${esc(it.brand)}" placeholder="e.g. Kroger, Swanson">
    <label for="keyword">Food type <span class="muted">(one or two words, used for FYI alerts)</span></label><input type="text" id="keyword" value="${esc(it.keyword)}" placeholder="${esc(itemKeyword(it) || 'e.g. carrots')}">
    <label for="category">Category</label><select id="category">${CATEGORIES.map(c => `<option ${c === it.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label for="upc">Barcode (UPC) <span class="muted">— most accurate</span></label>
    <div class="row"><input type="text" id="upc" inputmode="numeric" value="${esc(it.upc)}" style="flex:2;min-width:150px"><button class="btn secondary" id="scanUpc" style="flex:1">▥ Scan</button></div>
    <label for="lot">Lot code <span class="muted">(printed near the date)</span></label><input type="text" id="lot" value="${esc(it.lot)}" placeholder="e.g. 3896 or L24315A">
    <label for="bestBy">Best-by / use-by date</label><input type="date" id="bestBy" value="${esc(it.bestBy)}">
    <label>Label photo <span class="muted">(lot code and date)</span></label>
    <div id="ph">${await photoTag(it.photoId, 'label')}</div>
    <div id="labelOcr"></div>
    <div class="row"><button class="btn secondary" id="snap">📷 ${it.photoId ? 'Retake' : 'Photograph'} lot code / date</button>${it.photoId ? '<button class="btn secondary" id="reread">🔎 Read photo again</button>' : ''}</div>
    <label for="status">Where is it now?</label>
    <select id="status">${[['pantry', 'In the pantry / fridge / freezer'], ['used', 'Used up'], ['set-aside', 'Set aside (recall)'], ['discarded', 'Thrown out / returned']].map(([v, l]) => `<option value="${v}" ${v === it.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="row"><div style="flex:1;min-width:140px"><label for="purchased">Bought</label><input type="date" id="purchased" value="${esc(it.purchased)}"></div>
    <div style="flex:1;min-width:140px"><label for="store">Store</label><input type="text" id="store" value="${esc(it.store)}"></div></div>
    ${it.storeCode ? `<p class="muted small">Store item number from receipt: ${esc(it.storeCode)}</p>` : ''}
    ${batches.length ? `<p class="muted small">Used in: ${batches.map(b => `<a href="#batch/${b.id}">${esc(b.name)} (${esc(fmt(b.served))})</a>`).join(', ')}</p>` : ''}
    <button class="btn block" id="saveItem">Save</button>
    <button class="btn block danger" id="delItem">Delete item</button>`);
  const fields = ['name', 'brand', 'keyword', 'category', 'upc', 'lot', 'bestBy', 'status', 'purchased', 'store'];
  const collect = () => fields.forEach(f => it[f] = $('#' + f).value.trim());
  $('#scanUpc').onclick = () => scanBarcode((code, info) => { $('#upc').value = code; if (info && !$('#name').value) $('#name').value = info.name; if (info && !$('#brand').value) $('#brand').value = info.brand; });
  const runLabel = async () => {
    const box = $('#labelOcr');
    box.innerHTML = `<div class="notice"><span class="spinner"></span> Reading the label… the first time can take up to a minute.</div>`;
    try {
      const text = await readLabel(await getPhoto(it.photoId));
      const dates = findDates(text), { lot, candidates } = findLot(text, dates, $('#upc').value);
      const filled = [];
      const fill = (id, v, label) => { const el = $('#' + id); if (!v) return; if (!el.value) { el.value = v; el.classList.add('autofilled'); filled.push(label); } };
      fill('lot', lot, 'lot code'); if (dates[0]) fill('bestBy', dates[0].date, 'best-by date');
      const chips = [...(lot && $('#lot').value !== lot ? [['lot', lot]] : []), ...candidates.filter(c => c !== $('#lot').value).map(c => ['lot', c]),
        ...dates.filter(d => d.date !== $('#bestBy').value).map(d => ['bestBy', d.date])];
      box.innerHTML = `<div class="notice ${filled.length ? '' : 'warn'}">
        ${filled.length ? `<b>Filled in the ${filled.join(' and ')}</b> (highlighted). Please check against the package before saving.` : (lot || dates.length ? 'Found some codes — tap one below to use it.' : 'Couldn\'t read a lot code or date. Try again closer, straight on, in good light — or type them in.')}
        ${chips.length ? `<div class="chips">${chips.map(([f, v]) => `<button class="chip" data-f="${f}" data-v="${esc(v)}">${f === 'lot' ? 'Lot ' + esc(v) : 'Date ' + esc(fmt(v))}</button>`).join('')}</div>` : ''}
        ${text.trim() ? `<details><summary class="small">Text the app saw</summary><pre class="ocrtext">${esc(text.trim())}</pre></details>` : ''}</div>`;
      $$('.chip', box).forEach(b => b.onclick = () => { const el = $('#' + b.dataset.f); el.value = b.dataset.v; el.classList.add('autofilled'); toast('Filled in – remember to Save'); });
    } catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message || e)}</div>`; }
  };
  $('#snap').onclick = async () => {
    const f = await pickImage(); if (!f) return; collect();
    if (it.photoId) await delPhoto(it.photoId); it.photoId = uid(); await putPhoto(it.photoId, await shrink(f, 2000, 0.85)); await save();
    $('#ph').innerHTML = await photoTag(it.photoId, 'label'); runLabel();
  };
  if ($('#reread')) $('#reread').onclick = runLabel;
  $('#saveItem').onclick = async () => { collect(); if (!it.category || it.category === 'Other') it.category = guessCategory(it.name); await save({ sync: true }); toast('Saved'); history.back(); };
  $('#delItem').onclick = async () => {
    if (!confirm('Delete this item?')) return;
    S.items = S.items.filter(x => x.id !== it.id); S.trips.forEach(t => t.itemIds = t.itemIds.filter(x => x !== it.id)); S.batches.forEach(b => b.itemIds = b.itemIds.filter(x => x !== it.id));
    if (it.photoId) delPhoto(it.photoId); await save({ sync: true }); history.back();
  };
};
routes.item.back = true; routes.item.tab = 'pantry';

// ---------- PANTRY ----------
routes.pantry = function () {
  const groups = [['pantry', 'In the pantry'], ['set-aside', 'Set aside'], ['used', 'Used up'], ['discarded', 'Thrown out / returned']];
  const render = q => {
    q = q.toLowerCase();
    const list = S.items.filter(i => !q || `${i.brand} ${i.name} ${i.upc} ${i.lot}`.toLowerCase().includes(q)).sort((a, b) => (b.purchased || '').localeCompare(a.purchased || ''));
    $('#plist').innerHTML = groups.map(([k, label]) => { const g = list.filter(i => i.status === k); if (!g.length) return '';
      return `${k === 'used' || k === 'discarded' ? `<details><summary>${label} (${g.length})</summary>` : `<h2>${label} (${g.length})</h2>`}<div class="card">${g.map(i => `<a class="list-item" href="#item/${i.id}"><div><b>${esc([i.brand, i.name].filter(Boolean).join(' ') || '(no name)')}</b><br><span class="muted small">${esc(fmt(i.purchased))} · ${esc(i.store)}${i.upc ? ' · UPC ✓' : ''}${i.lot ? ' · lot ✓' : ''}</span></div><span class="chev">›</span></a>`).join('')}</div>${k === 'used' || k === 'discarded' ? '</details>' : ''}`; }).join('') || '<div class="empty">No items yet. Log a shopping trip first.</div>';
  };
  view('Pantry', `<input type="search" id="q" placeholder="Search items, UPC, lot…"><div id="plist"></div>`);
  $('#q').oninput = e => render(e.target.value); render('');
};

// ---------- SOUPS ----------
routes.meals = function () {
  const list = [...S.batches].sort((a, b) => b.served.localeCompare(a.served));
  view('Meals', `
    <a class="btn block" href="#batch/new">➕ Log a meal</a>
    <p class="muted small">Log each meal you cook with the date it was served and which ingredients went in. If one is recalled later, you'll know exactly which meals were affected.</p>
    <div class="card">${list.length ? list.map(b => `<a class="list-item" href="#batch/${b.id}"><div><b>${esc(b.name)}</b><br><span class="muted small">Served ${esc(fmt(b.served))} · ${b.itemIds.length} ingredients${b.allergens?.length ? ' · contains ' + esc(b.allergens.join(', ').toLowerCase()) : ''}</span></div><span class="chev">›</span></a>`).join('') : '<div class="empty">No meals logged yet.</div>'}</div>`);
};

routes.batch = function (id) {
  let b = id === 'new' ? { id: uid(), name: '', served: today(), servings: '', itemIds: [], allergens: [], notes: '', _new: true } : S.batches.find(x => x.id === id);
  if (!b) return view('Meal', '<div class="empty">Not found.</div>');
  const cand = S.items.filter(i => b.itemIds.includes(i.id) || i.status === 'pantry' || (i.purchased && daysAgo(i.purchased) <= 30))
    .sort((a, c) => (b.itemIds.includes(c.id) - b.itemIds.includes(a.id)) || (c.purchased || '').localeCompare(a.purchased || ''));
  view(b._new ? 'Log a meal' : 'Meal', `
    <label for="bname">What was cooked</label><input type="text" id="bname" value="${esc(b.name)}" placeholder="e.g. Chicken vegetable soup, spaghetti, chili">
    <div class="row"><div style="flex:1;min-width:140px"><label for="served">Date served</label><input type="date" id="served" value="${esc(b.served)}"></div>
    <div style="flex:1;min-width:140px"><label for="servings">Servings <span class="muted">(about)</span></label><input type="number" id="servings" inputmode="numeric" value="${esc(b.servings)}"></div></div>
    <h2>Ingredients used</h2>
    <input type="search" id="iq" placeholder="Filter ingredients…">
    <div class="card" id="ilist">${cand.length ? cand.map(i => `<label class="check" data-s="${esc((i.brand + ' ' + i.name).toLowerCase())}"><input type="checkbox" value="${i.id}" ${b.itemIds.includes(i.id) ? 'checked' : ''}><span>${esc([i.brand, i.name].filter(Boolean).join(' '))}<br><span class="muted small">bought ${esc(fmt(i.purchased))} · ${esc(i.store)}</span></span></label>`).join('') : '<p class="muted">No pantry items. Log a shopping trip first.</p>'}</div>
    <label class="check" style="border:0"><input type="checkbox" id="markUsed"><span>Mark checked ingredients as <b>used up</b></span></label>
    <h2>Contains allergens</h2>
    <div class="card">${ALLERGENS.map(a => `<label class="check"><input type="checkbox" class="alg" value="${a}" ${b.allergens?.includes(a) ? 'checked' : ''}><span>${a}</span></label>`).join('')}</div>
    <label for="bnotes">Notes</label><textarea id="bnotes" style="min-height:80px">${esc(b.notes)}</textarea>
    <button class="btn block" id="saveB">Save</button>
    ${b._new ? '' : '<button class="btn block danger" id="delB">Delete</button>'}`);
  $('#iq').oninput = e => { const q = e.target.value.toLowerCase(); $$('#ilist .check').forEach(l => l.hidden = q && !l.dataset.s.includes(q)); };
  $('#saveB').onclick = async () => {
    b.name = $('#bname').value.trim() || 'Meal'; b.served = $('#served').value; b.servings = $('#servings').value; b.notes = $('#bnotes').value;
    b.itemIds = $$('#ilist input:checked').map(x => x.value); b.allergens = $$('.alg:checked').map(x => x.value);
    if ($('#markUsed').checked) b.itemIds.forEach(i => { const it = itemById(i); if (it && it.status === 'pantry') it.status = 'used'; });
    if (b._new) { delete b._new; S.batches.push(b); }
    await save({ sync: true }); toast('Meal saved'); location.hash = 'meals';
  };
  if ($('#delB')) $('#delB').onclick = async () => { if (!confirm('Delete this meal record?')) return; S.batches = S.batches.filter(x => x.id !== b.id); await save(); location.hash = 'meals'; };
};
routes.batch.back = true; routes.batch.tab = 'meals';

// ---------- MORE ----------
routes.more = function () {
  const bk = S.lastBackup ? `Last backup ${fmt(S.lastBackup)}` : 'Never backed up';
  view('More', `
    <div class="card">
      <a class="list-item" href="#settings"><div><b>Settings</b><br><span class="muted small">State, stores, how often to check, auto-delete, your name</span></div><span class="chev">›</span></a>
      <a class="list-item" href="#alertsetup"><div><b>Phone alerts setup</b><br><span class="muted small">${S.settings.ghToken ? 'Automatic sync on' : 'Get notified even when the app is closed'}${S.lastSync ? ' · synced ' + esc(fmt(S.lastSync)) : ''}</span></div><span class="chev">›</span></a>
      <a class="list-item" href="#backup"><div><b>Backup & restore</b><br><span class="muted small">${esc(bk)}</span></div><span class="chev">›</span></a>
      <a class="list-item" href="#help"><div><b>How to use</b><br><span class="muted small">Install, daily use, and what to do in a recall</span></div><span class="chev">›</span></a>
    </div>
    <p class="small"><b>About Recall Watch.</b> A free app for anyone who cooks for other people: families, potlucks, food pantries, daycares, camps, shelters and community meals. Its purpose is simple: safer food for the people you feed. The idea started in a church soup kitchen.</p>
    <p class="muted small">Recall Watch checks FDA enforcement reports, FDA company recall announcements, and USDA meat/poultry/egg recalls. Records older than ${esc(S.settings.keepDays)} days are deleted automatically. It's a helper, not a guarantee — also watch for recall emails from stores where you use a loyalty card.</p>`);
};

const COMMON_STORES = ['Kroger', 'Walmart', 'Aldi', 'Food City', 'Ingles', 'Publix', 'Food Lion', 'Lidl', 'Target', 'Costco', "Sam's Club", "BJ's", 'Whole Foods', "Trader Joe's", 'H-E-B', 'Meijer', 'Safeway', 'Albertsons', 'Harris Teeter', 'Wegmans', 'Giant', 'Hy-Vee', 'Winn-Dixie', 'Piggly Wiggly', 'Dollar General', 'Family Dollar', 'Restaurant Depot', 'Food bank'];
const FREQS = [[1, 'Every hour'], [3, 'Every 3 hours'], [6, 'Every 6 hours'], [12, 'Twice a day'], [24, 'Once a day']];
const KEEPS = [[30, '30 days'], [60, '60 days (recommended)'], [90, '90 days'], [120, '120 days']];

function settingsForm(s) {
  const stores = [...new Set([...COMMON_STORES, ...s.stores])];
  return `
    <label for="state">Your state</label><select id="state"><option value="">Choose your state…</option>${Object.entries(STATES).map(([k, v]) => `<option value="${k}" ${k === s.state ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label>Where do you buy food? <span class="muted">(tick all that apply)</span></label>
    <div class="card" id="storeList" style="max-height:330px;overflow:auto">${stores.map(n => `<label class="check"><input type="checkbox" class="st" value="${esc(n)}" ${s.stores.includes(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div>
    <div class="row"><input type="text" id="newStore" placeholder="Another store or supplier" style="flex:2;min-width:160px"><button class="btn secondary" id="addStore" style="flex:1">Add</button></div>
    <label for="freq">How often to check for recalls</label><select id="freq">${FREQS.map(([v, l]) => `<option value="${v}" ${v === +s.checkEveryHours ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <p class="muted small">Used by phone alerts. The app also checks every time you open it. FDA's main recall list is updated weekly; company and USDA announcements come any day.</p>
    <label for="keep">Automatically delete records older than</label><select id="keep">${KEEPS.map(([v, l]) => `<option value="${v}" ${v === +s.keepDays ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <p class="muted small">Items (with barcodes, lot codes and photos), receipts, and meal records are deleted from this phone after this many days. Some illnesses, like Listeria, can appear weeks after eating, so a longer time catches more late recalls.</p>
    <label for="kname">Your name, kitchen, or group <span class="muted">(used in messages to the people you serve)</span></label><input type="text" id="kname" value="${esc(s.kitchenName)}" placeholder="e.g. The Smith family, Grace Church Community Meal, Oak Street Daycare">
    <label for="phone">Phone number people can reach you at <span class="muted">(optional – a Google Voice number keeps yours private)</span></label><input type="tel" id="phone" value="${esc(s.contactNumber)}">`;
}
function wireSettings(s, after) {
  $('#addStore').onclick = () => {
    const v = $('#newStore').value.trim(); if (!v) return;
    $('#storeList').insertAdjacentHTML('afterbegin', `<label class="check"><input type="checkbox" class="st" value="${esc(v)}" checked><span>${esc(v)}</span></label>`);
    $('#newStore').value = '';
  };
  $('#saveS').onclick = async () => {
    if (!$('#state').value) { toast('Please choose your state'); return; }
    const oldKeep = +s.keepDays, oldFreq = +s.checkEveryHours;
    s.state = $('#state').value; s.stores = $$('.st:checked').map(x => x.value);
    s.checkEveryHours = +$('#freq').value; s.keepDays = +$('#keep').value;
    s.kitchenName = $('#kname').value.trim(); s.contactNumber = $('#phone').value.trim(); s.setupDone = true;
    await save({ sync: true });
    if (+s.keepDays < oldKeep) { const n = await purgeOld(); if (n) toast(`Deleted ${n} old records`); }
    else toast('Settings saved');
    after();
  };
}
routes.welcome = function () {
  view('Welcome', `
    <div class="notice">Recall Watch helps anyone who cooks for other people keep food safe. It tracks the food you buy, checks it against FDA and USDA recalls, and tells you which meals were affected, so you can let people know quickly. Let's set it up for where you are.</div>
    ${settingsForm(S.settings)}
    <button class="btn block" id="saveS">Start using Recall Watch</button>`);
  wireSettings(S.settings, () => { location.hash = 'alerts'; });
};
routes.welcome.tab = 'alerts';
routes.soups = () => { location.hash = 'meals'; };
routes.settings = function () {
  view('Settings', settingsForm(S.settings) + `<button class="btn block" id="saveS">Save settings</button>`);
  wireSettings(S.settings, () => { location.hash = 'more'; });
};
routes.settings.back = true; routes.settings.tab = 'more';

// Phone alerts: the item list is sent to GitHub as an ENCRYPTED repository secret,
// so it is never visible in the public repository and is not copied by forks.
function guessRepo() {
  const h = location.hostname, p = location.pathname.split('/').filter(Boolean);
  return h.endsWith('.github.io') && p[0] ? `${h.split('.')[0]}/${p[0]}` : '';
}
function watchlist() {
  const keep = Number(S.settings.keepDays) || 60;
  return {
    state: S.settings.state, stores: S.settings.stores, notify: S.settings.notify, checkEveryHours: +S.settings.checkEveryHours || 12,
    items: S.items.filter(i => !i.purchased || daysAgo(i.purchased) <= keep).map(i => {
      const o = { id: i.id, name: i.name, brand: i.brand, purchased: i.purchased };
      for (const k of ['upc', 'lot', 'bestBy', 'keyword', 'storeCode', 'store']) if (i[k]) o[k] = i[k];
      return o;
    }),
  };
}
const b64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(bin); };
async function packedWatchlist() {
  const json = new TextEncoder().encode(JSON.stringify(watchlist()));
  const gz = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return 'gz:' + b64(gz);
}
async function syncWatchlist(quiet = false) {
  const repo = S.settings.ghRepo || guessRepo(), token = S.settings.ghToken;
  if (!repo || !token) { if (!quiet) toast('Set up phone alerts first'); return false; }
  const api = `https://api.github.com/repos/${repo}/actions`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  try {
    const packed = await packedWatchlist();
    if (packed.length > 47000) throw new Error('item list is too large – try a shorter "delete after" time');
    const kr = await fetch(`${api}/secrets/public-key`, { headers, cache: 'no-store' });
    if (!kr.ok) throw new Error(kr.status === 401 || kr.status === 403 || kr.status === 404 ? 'GitHub key was refused – check the repository name and key permissions' : `GitHub error ${kr.status}`);
    const { key, key_id } = await kr.json();
    const pk = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    const encrypted_value = b64(seal(new TextEncoder().encode(packed), pk));
    const r = await fetch(`${api}/secrets/WATCHLIST`, { method: 'PUT', headers, body: JSON.stringify({ encrypted_value, key_id }) });
    if (!r.ok) throw new Error(`Saving to GitHub failed (${r.status}) – check the key has "Secrets: Read and write"`);
    // Ask GitHub to run a check right away (needs "Actions: Read and write"; optional).
    fetch(`${api}/workflows/check-recalls.yml/dispatches`, { method: 'POST', headers, body: JSON.stringify({ ref: 'main' }) }).catch(() => {});
    S.lastSync = new Date().toISOString(); await setKV('state', S);
    if (!quiet) toast('Synced – phone alerts are up to date'); return true;
  } catch (e) { toast('Sync failed: ' + (e.message || e), 4500); return false; }
}
routes.alertsetup = function () {
  const s = S.settings, repo = s.ghRepo || guessRepo();
  view('Phone alerts setup', `
    <div class="notice">A free GitHub service checks new recalls against your item list and sends a notification to the free <b>ntfy</b> app on your phone, even when Recall Watch is closed. Your item list is sent to GitHub <b>encrypted</b>, so it isn't visible in your public repository and isn't copied by anyone who copies it. The app never stores anyone's contact information.</div>
    <h2>1. Your repository</h2>
    <label for="repo">GitHub repository <span class="muted">(owner/name)</span></label><input type="text" id="repo" value="${esc(repo)}" placeholder="yourname/recall-watch" autocapitalize="off">
    <p class="muted small">If you installed the app from someone else's link, enter your own copy here.</p>
    <h2>2. Sync key</h2>
    <p class="small">Paste the fine-grained GitHub key you made for this repository (permissions: <b>Secrets</b> and <b>Actions</b>, read and write). It is stored only on this phone.</p>
    <label for="tok">GitHub key</label><input type="password" id="tok" value="${esc(s.ghToken)}" autocomplete="off" placeholder="github_pat_…">
    <button class="btn block" id="saveTok">Save and sync now</button>
    ${S.lastSync ? `<p class="muted small">Last synced ${esc(new Date(S.lastSync).toLocaleString())}. The app syncs by itself after every change.</p>` : ''}
    <details><summary>No key? Sync by hand instead</summary>
      <p class="small">Tap Copy, then Open GitHub. Name the secret <b>WATCHLIST</b> (or tap the pencil on the existing one), paste into the box, and save. GitHub encrypts it. Repeat after each shopping trip.</p>
      <div class="row"><button class="btn secondary" id="copyWl">📋 Copy item list</button>${repo ? `<a class="btn secondary" target="_blank" rel="noopener" href="https://github.com/${esc(repo)}/settings/secrets/actions">Open GitHub</a>` : ''}</div>
    </details>
    <h2>3. Which alerts</h2>
    <label class="check"><input type="checkbox" id="nfyi" ${s.notify.includes('fyi') ? 'checked' : ''}><span>Also notify me for FYI matches (same food, different brand). <span class="muted">Can be noisy.</span></span></label>
    <p class="muted small">How often to check is set in More › Settings (now: ${esc((FREQS.find(f => f[0] === +s.checkEveryHours) || [0, 'Twice a day'])[1].toLowerCase())}).</p>`);
  $('#saveTok').onclick = async () => { s.ghRepo = $('#repo').value.trim(); s.ghToken = $('#tok').value.trim(); await save(); if (s.ghToken) syncWatchlist(); };
  $('#copyWl').onclick = async () => { try { await navigator.clipboard.writeText(await packedWatchlist()); toast('Copied'); } catch { toast('Copy failed'); } };
  $('#nfyi').onchange = async e => { s.notify = e.target.checked ? ['confirmed', 'likely', 'fyi'] : ['confirmed', 'likely']; await save({ sync: true }); };
};
routes.alertsetup.back = true; routes.alertsetup.tab = 'more';

routes.backup = function () {
  view('Backup & restore', `
    <div class="notice">Your records live only on this phone. Save a backup every week or two (email it to yourself or save it to Google Drive / iCloud) so nothing is lost if the phone is lost or replaced.</div>
    <label class="check"><input type="checkbox" id="withPhotos"><span>Include photos <span class="muted">(bigger file)</span></span></label>
    <button class="btn block" id="exp">⬇️ Save backup file</button>
    <h2>Restore</h2><p class="small">Restoring replaces everything on this phone with the backup.</p>
    <button class="btn block secondary" id="imp">⬆️ Restore from backup file</button>`);
  $('#exp').onclick = async () => {
    const out = { app: 'recall-watch', version: 1, saved: new Date().toISOString(), state: { ...S, settings: { ...S.settings, ghToken: '' } }, photos: {} };
    if ($('#withPhotos').checked) {
      const ids = [...S.trips.map(t => t.receiptId), ...S.items.map(i => i.photoId)].filter(Boolean);
      for (const id of ids) { const b = await getPhoto(id); if (b) out.photos[id] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const name = `recall-watch-backup-${today()}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); } catch { return; } }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
    S.lastBackup = today(); await save(); toast('Backup saved');
  };
  $('#imp').onclick = () => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json,.json';
    i.onchange = async () => {
      try {
        const j = JSON.parse(await i.files[0].text());
        if (j.app !== 'recall-watch') throw new Error('Not a Recall Watch backup');
        if (!confirm('Replace everything on this phone with this backup?')) return;
        const token = S.settings.ghToken; S = j.state; S.settings.ghToken = S.settings.ghToken || token;
        for (const [id, url] of Object.entries(j.photos || {})) await putPhoto(id, await (await fetch(url)).blob());
        await save(); toast('Backup restored'); location.hash = 'alerts';
      } catch (e) { toast('Restore failed: ' + e.message, 4000); }
    };
    i.click();
  };
};
routes.backup.back = true; routes.backup.tab = 'more';

routes.help = function () {
  view('How to use', `<div class="help">
    <h3>Every shopping trip (5 minutes)</h3>
    <ol><li>Shopping › <b>Log a shopping trip</b>. Pick the store and date.</li>
      <li><b>Photograph receipt</b>, then <b>Read items from receipt</b>. Fix names, untick non-food, tap Add.</li>
      <li>For meat, eggs, dairy, produce, frozen vegetables and spices: tap the item, <b>Scan</b> its barcode, and <b>Photograph lot code / date</b>. Type the lot code and best-by date.</li>
      <li>Use the same store loyalty card or membership for every purchase, so the stores can warn you too.</li></ol>
    <h3>Every meal you cook (1 minute)</h3>
    <ol><li>Meals › <b>Log a meal</b>. Say what was cooked, set the date served, tick the ingredients used.</li>
      <li>Tick "mark as used up" if the package is finished.</li></ol>
    <h3>When you get an alert</h3>
    <ol><li><b>Confirmed</b> = your barcode and lot/date match. <b>Likely</b> = your brand and product, or your barcode, match — check the lot code. <b>FYI</b> = same kind of food, different brand — usually nothing to do.</li>
      <li>Open the alert and work through the checklist.</li>
      <li>If an affected meal was served, tap <b>Draft a message</b>, copy it, and send it from your phone to the people who ate it. For a group, post or hand out a printed copy too.</li>
      <li>Mark the alert <b>handled</b> or <b>not ours</b> and add a note.</li></ol>
    <h3>Every week or two</h3>
    <ul><li>More › Backup & restore › <b>Save backup file</b>.</li></ul>
    <h3>Automatic clean-up</h3>
    <ul><li>Items (with barcodes, lot codes and photos), receipts and meal records are deleted from this phone after ${esc(S.settings.keepDays)} days. Change this in More › Settings. Backup files you saved elsewhere are not deleted automatically.</li></ul>
    <h3>Limits to know</h3>
    <ul><li>Recall notices name the states a product was sent to, not individual stores, so some alerts will be for products your store never carried. That's why the lot code check matters.</li>
      <li>FDA enforcement reports can lag company announcements by days or weeks; this app checks both.</li>
      <li>This is a helper, not a guarantee. When in doubt, throw it out.</li></ul>
    <p class="muted small">Recall data: FDA (openFDA enforcement reports and recall announcements) and USDA FSIS. Product names: Open Food Facts.</p></div>`);
};
routes.help.back = true; routes.help.tab = 'more';

// ---------- start ----------
(async function start() {
  await load();
  const purged = await purgeOld();
  if (!S.settings.setupDone && !location.hash.startsWith('#welcome')) location.hash = 'welcome';
  if (purged) setTimeout(() => toast(`Cleaned up ${purged} records older than ${S.settings.keepDays} days`), 800);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await route();
  loadRecalls().then(updateBadge);
})();
