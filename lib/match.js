// Shared recall-matching logic. Used by the phone app (browser) and by the
// daily GitHub check (Node). Plain JavaScript, no dependencies.

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const NATIONWIDE = [
  /nation\s*-?\s*wide/i, /all\s+(50\s+)?(u\.?\s?s\.?\s+)?states/i, /all\s+50/i,
  /throughout\s+the\s+(u\.?\s?s\.?|united\s+states)/i, /\bu\.?\s?s\.?\s+distribution/i,
  /distributed\s+(in|to)\s+the\s+(u\.?\s?s\.?|united\s+states)/i, /\bnational\s+distribution/i,
  /\bnationally\b/i, /\bcontinental\s+(u\.?\s?s|united\s+states)/i,
];

// Words too common to identify a product on their own.
const STOP = new Set(('a an and the of with in for to from by on or at as is are be ' +
  'oz lb lbs ct pk pack count size bag box can jar bottle case each ea fl gal qt pt ' +
  'g kg ml l pound pounds ounce ounces original classic natural fresh frozen brand ' +
  'value great store new ' +
  'family large small medium regular style premium select choice').split(' '));

export function norm(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|oes|ses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
export function words(s) {
  return norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}
function wordSet(s) { return new Set(norm(s).split(' ').map(stem)); }
function digitsOnly(s) { return String(s || '').replace(/\D+/g, ''); }

// The part of a UPC/EAN that identifies the maker + product, ignoring leading
// zeros and the check digit, so "0 41220 12345 6" and "041220123456" both match.
export function upcCore(upc) {
  let d = digitsOnly(upc);
  if (d.length < 8) return '';
  d = d.replace(/^0+/, '');
  if (d.length >= 11) d = d.slice(0, -1); // drop check digit
  return d.length >= 9 ? d.slice(-10) : '';
}

export function recallText(r) {
  return [r.title, r.product, r.reason, r.firm, r.codes, r.distribution, r.summary].filter(Boolean).join(' \n ');
}

// Does this recall reach the user's area? Returns a label or null.
export function regionMatch(r, settings) {
  const st = (settings.state || '').toUpperCase();
  const full = STATES[st] || '';
  const dist = [r.distribution, r.states].filter(Boolean).join(' ');
  const all = recallText(r) + ' ' + (r.states || '');
  const stateHit = !!st && (new RegExp(`(^|[^A-Za-z])${st}([^A-Za-z]|$)`).test(dist) ||
      (!!full && new RegExp(`\\b${full}\\b`, 'i').test(dist)));
  const nationwide = NATIONWIDE.some(re => re.test(dist));
  const unknown = !dist.trim();
  const storeHit = (settings.stores || []).some(s => { const k = norm(s); return k && wordBoundaryIncludes(norm(all), k); });
  if (storeHit && (stateHit || nationwide || unknown)) return 'your store';
  if (stateHit) return 'your state';
  if (nationwide) return 'nationwide';
  if (unknown) return 'area not listed';
  return null;
}
function wordBoundaryIncludes(hay, needle) {
  return (' ' + hay + ' ').includes(' ' + needle + ' ');
}

export function itemKeyword(item) {
  if (item.keyword) return words(item.keyword).join(' ');
  const w = words(item.name).filter(x => !words(item.brand || '').includes(x));
  return w.length ? w[w.length - 1] : '';
}

// Compare one purchased item to one recall.
// Returns {level, why} where level is 'confirmed' | 'likely' | 'fyi', or null.
export function itemMatch(item, r) {
  const text = recallText(r);
  const tset = wordSet(text);
  const tdigits = digitsOnly(text);
  const why = [];

  const core = upcCore(item.upc);
  const upcHit = core && tdigits.includes(core);
  if (upcHit) why.push('barcode (UPC) matches');

  let lotHit = false;
  const lot = norm(item.lot);
  if (lot && lot.replace(/ /g, '').length >= 3) {
    const nt = ' ' + norm(text) + ' ', flat = norm(text).replace(/ /g, '');
    const first = lot.split(' ')[0];
    const variants = [...new Set([lot, first, first.replace(/^l(?=\d)/, '')])].filter(v => v.replace(/ /g, '').length >= 3);
    lotHit = variants.some(v => nt.includes(' ' + v + ' ') || (v.replace(/ /g, '').length >= 5 && flat.includes(v.replace(/ /g, ''))));
    if (lotHit) why.push('lot code matches');
  }
  let dateHit = false;
  if (item.bestBy) {
    const d = new Date(item.bestBy + 'T12:00:00');
    if (!isNaN(d)) {
      const m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear(), yy = String(y).slice(2);
      const forms = [`${m}/${day}/${y}`, `${m}/${day}/${yy}`, `${String(m).padStart(2,'0')}/${String(day).padStart(2,'0')}/${y}`,
        `${String(m).padStart(2,'0')}/${String(day).padStart(2,'0')}/${yy}`, `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`];
      dateHit = forms.some(f => text.includes(f));
      if (dateHit) why.push('best-by date matches');
    }
  }

  const brandWords = words(item.brand);
  const brandHit = brandWords.length > 0 && brandWords.every(w => tset.has(w));
  const nameWords = words(item.name).filter(w => !brandWords.includes(w));
  const nameHits = nameWords.filter(w => tset.has(w));
  const kw = itemKeyword(item);
  const kwHit = kw && kw.split(' ').every(w => tset.has(w));

  if (upcHit && (lotHit || dateHit)) return { level: 'confirmed', why };
  if (brandHit && kwHit && (lotHit || dateHit)) { why.unshift('brand + product match'); return { level: 'confirmed', why }; }
  if (upcHit) return { level: 'likely', why };
  const code = digitsOnly(item.storeCode);
  if (code.length >= 5 && tset.has(code) && words(item.store).some(w => tset.has(w))) {
    why.unshift(`${item.store} item number ${code} mentioned`);
    return { level: 'likely', why };
  }
  if (brandHit && (kwHit || nameHits.length >= 1)) {
    why.unshift(`brand "${item.brand}" and product "${kwHit ? kw : nameHits.join(', ')}" mentioned`);
    return { level: 'likely', why };
  }
  if (!brandWords.length && nameWords.length >= 3 && nameHits.length >= 3 && nameHits.length / nameWords.length >= 0.75) {
    why.unshift(`product name "${nameHits.join(' ')}" matches`);
    return { level: 'likely', why };
  }
  if (kwHit) return { level: 'fyi', why: [`mentions "${kw}" (different or unknown brand)`] };
  return null;
}

const LEVEL_RANK = { confirmed: 3, likely: 2, fyi: 1 };

// Match every item against every recall in the user's area.
// items: [{id,name,brand,upc,lot,bestBy,keyword,purchased}]
export function findMatches(recalls, items, settings, opts = {}) {
  const lookbackDays = opts.lookbackDays ?? 120;
  const out = [];
  for (const r of recalls) {
    const region = regionMatch(r, settings);
    if (!region) continue;
    const hits = [];
    for (const it of items) {
      if (it.purchased && r.date) {
        // Ignore recalls that ended long before the item was bought.
        const gap = (new Date(it.purchased) - new Date(r.date)) / 86400000;
        if (gap > lookbackDays) continue;
      }
      const m = itemMatch(it, r);
      if (m) hits.push({ itemId: it.id, itemName: [it.brand, it.name].filter(Boolean).join(' '), ...m });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    out.push({ recall: r, region, level: hits[0].level, hits });
  }
  out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || String(b.recall.date).localeCompare(String(a.recall.date)));
  return out;
}
