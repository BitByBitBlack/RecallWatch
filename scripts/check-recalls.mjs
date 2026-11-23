// Daily recall check. Runs on GitHub's free servers (see .github/workflows).
// 1. Downloads recent food recalls from FDA and USDA.
// 2. Saves them to data/recalls.json so the phone app can read them.
// 3. Compares them to your item list and sends a phone notification through
//    ntfy for any new match.
// Your item list and settings come from the encrypted repository secret
// WATCHLIST, written by the app, so they are never visible in this public repo.
// No one's contact information is ever stored here.

import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { findMatches } from '../lib/match.js';

const DAYS = 150;
const UA = 'Mozilla/5.0 (compatible; RecallWatch/1.0; food recall checker)';
const now = new Date();
const since = new Date(now - DAYS * 86400000);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const clip = (s, n = 1500) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&[a-z]+;/g, ' ');
const isoDate = s => {
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10);
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fdaEnforcement() {
  const out = [];
  for (let skip = 0; skip < 5000; skip += 1000) {
    const url = `https://api.fda.gov/food/enforcement.json?search=report_date:[${ymd(since)}+TO+${ymd(now)}]&sort=report_date:desc&limit=1000&skip=${skip}`;
    let j;
    try { j = await getJSON(url); } catch (e) { if (skip && /404/.test(e.message)) break; throw e; }
    for (const r of j.results || []) {
      out.push({
        id: 'fda-' + r.recall_number,
        source: 'FDA enforcement report',
        title: clip(r.product_description, 160),
        product: clip(r.product_description),
        reason: clip(r.reason_for_recall, 600),
        firm: r.recalling_firm,
        codes: clip(r.code_info, 1200),
        distribution: clip(r.distribution_pattern, 600),
        classification: r.classification,
        status: r.status,
        date: isoDate(r.recall_initiation_date || r.report_date),
        reported: isoDate(r.report_date),
        url: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts',
      });
    }
    if ((j.results || []).length < 1000) break;
  }
  return out;
}

async function usda() {
  const j = await getJSON('https://www.fsis.usda.gov/fsis/api/recall/v/1');
  const list = Array.isArray(j) ? j : (j.data || []);
  return list.filter(r => {
    const d = new Date(r.field_recall_date);
    return (!r.langcode || /^en/i.test(r.langcode)) && !isNaN(d) && d >= since;
  }).map(r => ({
    id: 'usda-' + (r.field_recall_number || r.field_title),
    source: 'USDA FSIS',
    title: clip(r.field_title, 200),
    product: clip(stripHtml(r.field_product_items)),
    reason: clip([r.field_recall_reason, stripHtml(r.field_summary)].filter(Boolean).join('. '), 900),
    firm: r.field_establishment,
    codes: '',
    distribution: clip(r.field_states, 600),
    classification: r.field_recall_classification || r.field_risk_level,
    status: r.field_active_notice === 'True' ? 'Ongoing' : (r.field_closed_date ? 'Closed' : ''),
    date: isoDate(r.field_recall_date),
    url: 'https://www.fsis.usda.gov/recalls',
  }));
}

async function fdaPressReleases() {
  const res = await fetch('https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml', { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const tag = (s, t) => { const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '') : ''; };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const it = m[1];
    const link = stripHtml(tag(it, 'link')).trim();
    const title = clip(stripHtml(tag(it, 'title')), 300);
    return {
      id: 'fdapr-' + link.split('/').filter(Boolean).pop(),
      source: 'FDA company announcement',
      title, product: title,
      reason: clip(stripHtml(tag(it, 'description')), 900),
      firm: '', codes: '', distribution: '',
      classification: '', status: '',
      date: isoDate(tag(it, 'pubDate')),
      url: link,
    };
  }).filter(r => r.date && new Date(r.date) >= since);
}

async function loadConfig() {
  const raw = (process.env.WATCHLIST || '').trim();
  if (raw) {
    try {
      const txt = raw.startsWith('gz:') ? gunzipSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8') : raw;
      return JSON.parse(txt);
    } catch (e) { console.error('WATCHLIST secret could not be read:', e.message); }
  }
  try { return JSON.parse(await readFile('watchlist.json', 'utf8')); } catch { return { items: [] }; }
}

async function main() {
  const wl = await loadConfig();
  // How often to check is chosen in the app (More > Settings). GitHub wakes this
  // script every hour; it only does the work when a check is due.
  const everyHours = Number(wl.checkEveryHours) || 12;
  let last = null;
  try { last = JSON.parse(await readFile('data/recalls.json', 'utf8')).updated; } catch {}
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (!manual && last && now - new Date(last) < everyHours * 3600000 - 10 * 60000) {
    console.log(`Not due yet (checking every ${everyHours} h, last check ${last}).`);
    return;
  }
  const sources = {};
  let recalls = [];
  for (const [name, fn] of [['FDA enforcement reports', fdaEnforcement], ['USDA FSIS', usda], ['FDA company announcements', fdaPressReleases]]) {
    try { const r = await fn(); recalls.push(...r); sources[name] = { ok: true, count: r.length }; }
    catch (e) { sources[name] = { ok: false, error: String(e.message || e) }; console.error(name, e); }
  }
  const seen = new Set();
  recalls = recalls.filter(r => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // If every source failed, keep yesterday's data instead of wiping it.
  if (!recalls.length) {
    try { recalls = JSON.parse(await readFile('data/recalls.json', 'utf8')).recalls || []; } catch {}
  }
  await writeFile('data/recalls.json', JSON.stringify({ updated: now.toISOString(), everyHours, days: DAYS, sources, recalls }));
  console.log('Sources:', JSON.stringify(sources));

  // Phone notifications for matches against your watchlist.
  const topic = process.env.NTFY_TOPIC;
  if (!topic || !(wl.items || []).length) { console.log('No notification topic or empty watchlist; done.'); return; }

  let notified = {}; try { notified = JSON.parse(await readFile('data/notified.json', 'utf8')); } catch {}
  const levels = wl.notify || ['confirmed', 'likely'];
  const matches = findMatches(recalls, wl.items, { state: wl.state || '', stores: wl.stores || [] })
    .filter(m => levels.includes(m.level));
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  const appUrl = owner ? `https://${owner.toLowerCase()}.github.io/${repo}/#alerts` : '';

  for (const m of matches) {
    const key = m.recall.id + '|' + m.hits.map(h => h.itemId + ':' + h.level).sort().join(',');
    if (notified[key]) continue;
    const items = m.hits.filter(h => levels.includes(h.level)).map(h => `• ${h.itemName} (${h.level}: ${h.why.join('; ')})`).join('\n');
    const body = `${m.recall.title}\n\nYour items:\n${items}\n\nReason: ${clip(m.recall.reason, 300)}\nArea: ${m.region}\n\nOpen Recall Watch for the checklist and guest message.`;
    const title = (m.level === 'confirmed' ? 'RECALL MATCH (confirmed)' : 'Possible recall match') + ' - kitchen';
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST', body,
      headers: { Title: title, Priority: m.level === 'confirmed' ? 'urgent' : 'high', Tags: 'warning', ...(appUrl ? { Click: appUrl } : {}) },
    });
    console.log('Notified', m.recall.id, res.status);
    if (res.ok) notified[key] = now.toISOString();
  }
  await writeFile('data/notified.json', JSON.stringify(notified, null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
