'use strict';
{
// ============ Hilfsfunktionen ============
const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur = new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'});
const eur0 = new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR', maximumFractionDigits:0});
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const today = () => { const d = new Date(); d.setHours(12,0,0,0); return d; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const key = d => iso(d).slice(0,7);
const mi = d => d.getFullYear()*12 + d.getMonth();
const fromMi = n => new Date(Math.floor(n/12), n%12, 1, 12);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const med = a => { if (!a.length) return 0; const b = [...a].sort((x,y)=>x-y), h = b.length>>1; return b.length%2 ? b[h] : (b[h-1]+b[h])/2; };
const avg = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
const r2 = v => Math.round(v*100)/100;

// ============ Stammdaten ============
const ACC = [
  {id:'giro', name:'Sparkasse Giro',  sub:'Girokonto',         ab:'S', c:'#d16d74'},
  {id:'mm',   name:'Miles & More',    sub:'Kreditkarte',       ab:'M', c:'#4f6694'},
  {id:'c24',  name:'C24 Bank',        sub:'Haushaltskonto',    ab:'C', c:'#4c9bb0'},
  {id:'tr',   name:'Trade Republic',  sub:'Verrechnungskonto', ab:'T', c:'#5a5a62'}];
const AC = Object.fromEntries(ACC.map(a => [a.id, a]));
const CAT = {Lebensmittel:'#7fb59a', Wohnen:'#8e9fd6', Mobilität:'#e0a87a', Restaurants:'#d98fa8', Shopping:'#b49ad8',
  Abos:'#7cb3d4', Versicherung:'#c9b27a', Drogerie:'#8fc9b8', Gesundheit:'#9db8e0', Sport:'#a6c37d', Elektronik:'#e3928a',
  Freizeit:'#e6b98a', Urlaub:'#7fc4c9', Geschenke:'#e0a0c0', Sonstiges:'#b9b9c4',
  Gehalt:'#6fae8f', Zinsen:'#8cc29a', 'Sonstige Einnahme':'#a7cfa0', Umbuchung:'#b7bccb'};
const IN_CATS = ['Gehalt', 'Zinsen', 'Sonstige Einnahme'];
const OUT_CATS = Object.keys(CAT).filter(c => !IN_CATS.includes(c) && c !== 'Umbuchung');

// ============ Speicher (IndexedDB) ============
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const q = indexedDB.open('finanzen', 1);
      q.onupgradeneeded = () => { const d = q.result; d.createObjectStore('tx', {keyPath:'id'}); d.createObjectStore('kv'); };
      q.onsuccess = () => { this.db = q.result; res(); };
      q.onerror = () => rej(q.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all()     { return this.run('tx', 'readonly', s => s.getAll()); },
  put(list) { return this.run('tx', 'readwrite', s => { list.forEach(x => s.put(x)); }); },
  del(ids)  { return this.run('tx', 'readwrite', s => { ids.forEach(i => s.delete(i)); }); },
  clear()   { return this.run('tx', 'readwrite', s => { s.clear(); }); },
  get(k)    { return this.run('kv', 'readonly', s => s.get(k)); },
  set(k, v) { return this.run('kv', 'readwrite', s => { s.put(v, k); }); }
};
// Buchung im Speicher: {id, date:'YYYY-MM-DD', acc, payee, cat, amt, tr, g}  + d (Date, nur im Arbeitsspeicher)
const strip = ({d, ...rest}) => rest;
const hydrate = t => ({...t, d: new Date(t.date + 'T12:00')});

// ============ Zustand ============
let RULES = {}, MAPS = {}, TX = [], START = {giro:0, mm:0, c24:0, tr:0}, dismissed = new Set(), lastBackup = null;
let selK = key(today()), filt = null, type = 'out', editing = null;

async function saveTx(add, removeIds = []) {
  if (removeIds.length) { await DB.del(removeIds); TX = TX.filter(t => !removeIds.includes(t.id)); }
  if (add.length) { await DB.put(add.map(strip)); TX.push(...add.map(hydrate)); }
  askPersist();
}
let persistAsked = false;
async function askPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch {}
}

// ============ Rechenlogik ============
const inM = k => TX.filter(t => key(t.d) === k);
const sIn = L => L.filter(t => !t.tr && t.amt > 0).reduce((s,t) => s + t.amt, 0);
const sOut = L => -L.filter(t => !t.tr && t.amt < 0).reduce((s,t) => s + t.amt, 0);
const bal = (id, upto) => (START[id] || 0) + TX.filter(t => t.acc === id && (!upto || t.d <= upto)).reduce((s,t) => s + t.amt, 0);
function monthKeys() {
  const now = mi(today()); let lo = now, hi = now;
  TX.forEach(t => { const m = mi(t.d); if (m < lo) lo = m; if (m > hi) hi = m; });
  const out = []; for (let m = lo; m <= hi; m++) out.push(key(fromMi(m)));
  return out;
}
// Fixkosten: gleicher Empfänger, max. 1× pro Monat, gleicher Rhythmus (1/3/12 Monate), Betrag ±12 %
function fixed() {
  const g = {};
  TX.forEach(t => { if (!t.tr && t.amt < 0) (g[t.payee.toLowerCase()] ||= []).push(t); });
  const out = [];
  for (const p in g) {
    const L = g[p].sort((a,b) => a.d - b.d), ms = L.map(t => mi(t.d));
    if (L.length < 3 || new Set(ms).size !== ms.length) continue;
    const iv = ms.slice(1).map((v,i) => v - ms[i]), st = iv[0];
    if (!iv.every(v => v === st) || ![1,3,12].includes(st)) continue;
    const am = L.map(t => -t.amt), md = med(am);
    if (!am.every(v => Math.abs(v - md) / md <= .12)) continue;
    const last = L[L.length-1], prev = am[am.length-2];
    out.push({p:last.payee, cat:last.cat, acc:last.acc, st, last:-last.amt, prev, mon:-last.amt/st,
      up: -last.amt > prev*1.02, day:last.d.getDate(), lm:ms[ms.length-1], lk:key(last.d)});
  }
  return out.sort((a,b) => b.mon - a.mon);
}
function hints(k, FX, MK) {
  const H = [], L = inM(k), before = TX.filter(t => key(t.d) < k), fp = new Set(FX.map(f => f.p.toLowerCase()));
  if (TX.length && (!lastBackup || (today() - new Date(lastBackup)) > 30*864e5))
    H.push({id:'bk'+key(today()), c:'#8e9fd6', i:'↓', t:'Backup empfohlen', d: lastBackup ? `Letzte Sicherung am ${new Date(lastBackup).toLocaleDateString('de-DE')}` : 'Deine Daten liegen nur auf diesem Handy. Sichere sie regelmäßig unter „Mehr“.'});
  L.filter(t => !t.tr && t.amt < 0 && !fp.has(t.payee.toLowerCase())).forEach(t => {
    const a = -t.amt, hist = before.filter(x => x.cat === t.cat && !x.tr && x.amt < 0).map(x => -x.amt), m = med(hist);
    if (before.length && !before.some(x => x.payee.toLowerCase() === t.payee.toLowerCase()) && a > 150)
      H.push({id:'n'+t.id, c:'#e3928a', i:'!', t:'Neuer Empfänger, hoher Betrag', d:`${esc(t.payee)} · ${eur.format(a)} · ${esc(AC[t.acc].name)}`});
    else if (hist.length >= 3 && a > Math.max(150, m*3))
      H.push({id:'h'+t.id, c:'#e0a87a', i:'↑', t:'Ungewöhnlich hohe Ausgabe', d:`${esc(t.payee)}: ${eur.format(a)}, üblich in ${esc(t.cat)} sind ca. ${eur0.format(m)}`});
  });
  const ki = MK.indexOf(k), prevK = MK.slice(Math.max(0, ki-6), ki);
  if (prevK.length >= 3) {
    new Set(L.filter(t => !t.tr && t.amt < 0).map(t => t.cat)).forEach(c => {
      const cur = sOut(L.filter(t => t.cat === c)), av = avg(prevK.map(p => sOut(inM(p).filter(t => t.cat === c))));
      if (av > 0 && cur > av*1.4 && cur - av > 60)
        H.push({id:'c'+c+k, c:'#b49ad8', i:'%', t:`${esc(c)} ${Math.round((cur/av-1)*100)} % über Ø`, d:`${eur0.format(cur)} statt durchschnittlich ${eur0.format(av)} im Monat`});
    });
  }
  if (k === key(today()))
    FX.filter(f => f.st === 1 && f.lm === mi(today()) - 1 && today().getDate() > f.day + 3)
      .forEach(f => H.push({id:'m'+f.p+k, c:'#7cb3d4', i:'?', t:'Fixkosten fehlen noch', d:`${esc(f.p)} (${eur.format(f.last)}) wird sonst um den ${f.day}. abgebucht`}));
  FX.filter(f => f.up && f.lk === k)
    .forEach(f => H.push({id:'u'+f.p+k, c:'#c9b27a', i:'€', t:`${esc(f.p)} ist teurer geworden`, d:`${eur.format(f.prev)} → ${eur.format(f.last)}`}));
  return H.filter(h => !dismissed.has(h.id));
}

// ============ Darstellung ============
function count(el, to, f = eur) {
  if (RM) { el.textContent = f.format(to); return; }
  const from = +el.dataset.v || 0, t0 = performance.now(); el.dataset.v = to;
  const step = n => { const p = Math.min(1, (n - t0) / 800), e = 1 - Math.pow(1 - p, 3); el.textContent = f.format(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const mDate = k => { const [y,m] = k.split('-'); return new Date(+y, m-1, 1); };
const mName = k => mDate(k).toLocaleDateString('de-DE', {month:'long', year:'numeric'});
const mShort = k => mDate(k).toLocaleDateString('de-DE', {month:'short'}).replace('.', '');
function spark(id, MK) {
  const pts = MK.slice(-6).map(k => { const d = mDate(k); return bal(id, new Date(d.getFullYear(), d.getMonth()+1, 0, 23)); });
  if (pts.length < 2) return '';
  const mn = Math.min(...pts), mx = Math.max(...pts), st = 100 / (pts.length - 1);
  return `<svg viewBox="0 0 100 32" preserveAspectRatio="none"><polyline fill="none" stroke="${AC[id].c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts.map((v,i) => `${i*st},${30 - ((v-mn)/((mx-mn)||1))*26}`).join(' ')}"/></svg>`;
}
function render() {
  const MK = monthKeys(); if (!MK.includes(selK)) selK = key(today());
  const ki = MK.indexOf(selK), k = selK, L = inM(k), FX = fixed(), I = sIn(L), O = sOut(L), S = I - O, mon = mName(k).split(' ')[0];
  $('mlabel').textContent = mName(k); $('prev').disabled = ki === 0; $('next').disabled = ki === MK.length - 1;
  $('headline').textContent = !TX.length ? 'Willkommen' : S >= 0 ? `Im ${mon} bleiben dir ${eur0.format(S)}` : `Im ${mon} fehlen ${eur0.format(-S)}`;
  count($('saldo'), S); count($('kin'), I, eur0); count($('kout'), O, eur0);
  $('krate').textContent = I ? Math.round(S / I * 100) + ' %' : '–';
  $('total').textContent = 'Gesamt ' + eur0.format(ACC.reduce((s,a) => s + bal(a.id), 0));
  $('accs').innerHTML = ACC.map(a => { const b = bal(a.id); return `<button class="acc glass${filt === a.id ? ' on' : ''}" style="--c:${a.c}" data-acc="${a.id}"><div class="dot">${a.ab}</div>${spark(a.id, MK)}<div class="n">${a.name}</div><div class="s">${a.id === 'mm' && b < 0 ? 'Offen bis zur Abrechnung' : a.sub}</div><div class="v ${b < 0 ? 'neg' : ''}">${eur.format(b)}</div></button>`; }).join('');

  // Hinweise
  if (!TX.length) {
    $('hints').innerHTML = `<section class="glass card welcome"><b style="font-size:17px">Los geht's</b><p>Trage unter „Mehr“ deine Startsalden ein und erfasse deine erste Buchung. Zum Ausprobieren kannst du auch Beispieldaten laden.</p><div class="acts"><button class="btn pri" data-act="new">Erste Buchung</button><button class="btn" data-act="import">CSV importieren</button><button class="btn" data-act="more">Startsalden</button><button class="btn" data-act="demo">Beispieldaten</button></div></section>`;
  } else {
    const H = hints(k, FX, MK);
    $('hints').innerHTML = H.length ? `<div class="sec"><h2>Hinweise</h2><span class="lbl">${H.length} neu</span></div>` + H.map((h,i) => `<div class="hint glass" style="--hc:${h.c};animation-delay:${i*.07}s"><div class="ic">${h.i}</div><p><b>${h.t}</b>${h.d}</p><button class="x" data-dis="${esc(h.id)}">Ok</button></div>`).join('') : '';
  }

  // Einkommen
  const prevK = MK.slice(0, ki).filter(x => inM(x).length), inc = x => sIn(inM(x)), av = n => avg(prevK.slice(-n).map(inc));
  $('inc').textContent = eur0.format(I);
  if (prevK.length) {
    const a6 = av(6), d = a6 ? (I / a6 - 1) * 100 : 0;
    $('incd').innerHTML = `<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${d.toFixed(0)} %</span> <span style="color:var(--mut);font-weight:600">zum Ø ${Math.min(6, prevK.length)} Mon.</span>`;
    const A = [...new Set([3,6,12].map(n => Math.min(n, prevK.length)))].map(n => ({n, v:av(n)}));
    $('avgs').innerHTML = A.map(x => `<div class="pill">Ø ${x.n} Mon.<b>${eur0.format(x.v)}</b></div>`).join('');
    const all = prevK.slice(-12).map(inc).concat(I), mn = Math.min(...all), mx = Math.max(...all);
    $('rmark').style.left = ((I - mn) / ((mx - mn) || 1) * 100) + '%';
    $('rmin').textContent = 'Min ' + eur0.format(mn); $('rmax').textContent = 'Max ' + eur0.format(mx);
    $('plan').textContent = eur0.format(Math.min(...A.map(x => x.v)));
  } else {
    $('incd').textContent = ''; $('avgs').innerHTML = '<div class="pill" style="grid-column:1/-1">Durchschnitte erscheinen ab dem zweiten Monat</div>';
    $('rmark').style.left = '50%'; $('rmin').textContent = ''; $('rmax').textContent = ''; $('plan').textContent = '–';
  }

  // Balken
  const B = MK.slice(Math.max(0, ki - 5), ki + 1), bv = B.map(x => { const l = inM(x); return [sIn(l), sOut(l)]; }), bm = Math.max(...bv.flat()) || 1;
  $('bars').innerHTML = B.map((x,i) => `<div class="bm${x === k ? ' cur' : ''}"><div class="bp"><i style="background:#9fd1b8" data-h="${bv[i][0]/bm*100}"></i><i style="background:#eab3b9" data-h="${bv[i][1]/bm*100}"></i></div><span>${mShort(x)}</span></div>`).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.bp i').forEach(e => e.style.height = e.dataset.h + '%')));

  // Donut
  const cs = {}; L.filter(t => !t.tr && t.amt < 0).forEach(t => cs[t.cat] = (cs[t.cat] || 0) - t.amt);
  const ce = Object.entries(cs).sort((a,b) => b[1] - a[1]), C = 2 * Math.PI * 46; let off = 0;
  $('dsvg').innerHTML = `<circle cx="60" cy="60" r="46" stroke="rgba(31,36,51,.05)"/>` + ce.map(([c,v]) => { const len = v / (O || 1) * C, s = `<circle cx="60" cy="60" r="46" stroke="${CAT[c] || '#bbb'}" stroke-dasharray="0 ${C}" data-d="${Math.max(0, len - 1.5)} ${C}" stroke-dashoffset="${-off}"/>`; off += len; return s; }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('#dsvg circle[data-d]').forEach(e => e.setAttribute('stroke-dasharray', e.dataset.d))));
  $('dtot').textContent = eur0.format(O);
  $('clist').innerHTML = ce.slice(0, 6).map(([c,v]) => `<li><i style="background:${CAT[c] || '#bbb'}"></i><span>${esc(c)}</span><span>${eur0.format(v)}</span></li>`).join('') || '<li class="empty">Keine Ausgaben</li>';

  // Fixkosten
  $('fixsum').textContent = FX.length ? eur0.format(FX.reduce((s,f) => s + f.mon, 0)) + ' / Monat' : '';
  $('fix').innerHTML = FX.map(f => `<div class="row" data-fix="${esc(f.p)}"><div class="ci" style="background:${CAT[f.cat] || '#bbb'}">${esc(f.p[0])}</div><div class="t"><b>${esc(f.p)}${f.up ? '<span class="tag">teurer</span>' : ''}</b><small>${f.st === 1 ? 'monatlich' : f.st === 3 ? 'vierteljährlich' : 'jährlich'} · ${AC[f.acc].name}</small></div><div class="a">${eur.format(f.last)}${f.st > 1 ? `<small>≈ ${eur.format(f.mon)}/Mon.</small>` : ''}</div></div>`).join('')
    || '<div class="empty">Werden automatisch erkannt, sobald eine Zahlung mindestens dreimal regelmäßig vorkommt.</div>';

  // Buchungen
  const chip = $('chip'); chip.hidden = !filt; if (filt) chip.textContent = AC[filt].name + ' ✕';
  const tl = L.filter(t => !filt || t.acc === filt).sort((a,b) => b.d - a.d || (a.amt < b.amt ? -1 : 1)); let lastD = '';
  $('txs').innerHTML = tl.map(t => {
    const ds = t.d.toLocaleDateString('de-DE', {weekday:'long', day:'numeric', month:'long'}), h = ds !== lastD ? `<div class="day">${ds}</div>` : ''; lastD = ds;
    return h + `<div class="row" data-tx="${esc(t.id)}"><div class="ci" style="background:${CAT[t.cat] || '#bbb'}">${esc((t.payee[0] || '?').toUpperCase())}</div><div class="t"><b>${esc(t.payee)}</b><small>${esc(t.cat)} · ${AC[t.acc]?.name || ''}</small></div><div class="a ${t.tr ? '' : t.amt > 0 ? 'pos' : ''}" style="${t.tr ? 'color:var(--mut)' : ''}">${t.amt > 0 ? '+' : ''}${eur.format(t.amt)}</div></div>`;
  }).join('') || '<div class="empty">Keine Buchungen in diesem Monat</div>';
}

// ============ Toast ============
let tt; const toast = m => { const e = $('toast'); e.textContent = m; e.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('show'), 2400); };

// ============ Buchungs-Formular ============
const sheet = $('sheet'), more = $('more');
const opt = (list, sel) => list.map(([v,l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
const accOpts = sel => opt(ACC.map(a => [a.id, a.name]), sel);
function setType(t, cat) {
  type = t;
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const isTr = t === 'tr';
  $('wcat').hidden = isTr; $('wto').hidden = !isTr;
  $('lacc').textContent = isTr ? 'Von' : 'Konto';
  $('lpay').textContent = isTr ? 'Bezeichnung' : t === 'in' ? 'Von wem' : 'Empfänger';
  $('fpay').placeholder = isTr ? 'z. B. Sparplan' : t === 'in' ? 'z. B. Arbeitgeber' : 'z. B. REWE';
  if (!isTr) { const list = t === 'in' ? IN_CATS : OUT_CATS; $('fcat').innerHTML = opt(list.map(c => [c,c]), cat || list[0]); }
}
// Kategorie-Vorschlag anhand früherer Buchungen beim gleichen Empfänger
$('fpay').addEventListener('change', () => {
  if (type === 'tr' || editing) return;
  const p = $('fpay').value.trim().toLowerCase(); if (RULES[p] && IN_CATS.includes(RULES[p]) === (type === 'in')) { $('fcat').value = RULES[p]; return; }
  const prev = [...TX].reverse().find(t => !t.tr && t.payee.toLowerCase() === p);
  if (prev && (type === 'in') === (prev.amt > 0)) { $('fcat').value = prev.cat; $('facc').value = prev.acc; }
});
function openForm(t) {
  editing = t || null;
  $('payees').innerHTML = [...new Set(TX.filter(x => !x.tr).map(x => x.payee))].slice(-200).map(p => `<option value="${esc(p)}">`).join('');
  $('ftitle').textContent = t ? 'Buchung bearbeiten' : 'Neue Buchung';
  $('fdel').hidden = !t;
  if (t && t.tr) {
    const pair = TX.filter(x => x.g && x.g === t.g), from = pair.find(x => x.amt < 0) || t, to = pair.find(x => x.amt > 0) || t;
    setType('tr'); $('facc').innerHTML = accOpts(from.acc); $('fto').innerHTML = accOpts(to.acc);
    $('famt').value = String(Math.abs(t.amt)).replace('.', ','); $('fpay').value = t.payee; $('fdate').value = t.date;
  } else if (t) {
    setType(t.amt > 0 ? 'in' : 'out', t.cat); $('facc').innerHTML = accOpts(t.acc); $('fto').innerHTML = accOpts('giro');
    $('famt').value = String(Math.abs(t.amt)).replace('.', ','); $('fpay').value = t.payee; $('fdate').value = t.date;
  } else {
    setType('out'); $('facc').innerHTML = accOpts(filt || 'giro'); $('fto').innerHTML = accOpts('tr');
    $('famt').value = ''; $('fpay').value = '';
    const sd = selK === key(today()) ? today() : mDate(selK); $('fdate').value = iso(sd);
  }
  sheet.classList.add('open');
  if (!t) setTimeout(() => $('famt').focus(), 350);
}
document.querySelectorAll('#seg button').forEach(b => b.onclick = () => setType(b.dataset.t));
$('fab').onclick = () => openForm();
const oldIds = t => t.tr && t.g ? TX.filter(x => x.g === t.g).map(x => x.id) : [t.id];
$('form').onsubmit = async e => {
  e.preventDefault();
  const v = parseFloat($('famt').value.replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!(v > 0)) { toast('Bitte einen Betrag eingeben'); $('famt').focus(); return; }
  const date = $('fdate').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Bitte ein Datum wählen'); return; }
  const payee = $('fpay').value.trim(), acc = $('facc').value, amt = r2(v);
  let add;
  if (type === 'tr') {
    const to = $('fto').value; if (to === acc) { toast('Von- und Nach-Konto müssen verschieden sein'); return; }
    const g = uid(), label = payee || 'Umbuchung';
    add = [{id:uid(), date, acc, payee:label, cat:'Umbuchung', amt:-amt, tr:true, g},
           {id:uid(), date, acc:to, payee:label, cat:'Umbuchung', amt, tr:true, g}];
  } else {
    if (!payee) { toast(type === 'in' ? 'Bitte angeben, von wem' : 'Bitte einen Empfänger angeben'); $('fpay').focus(); return; }
    add = [{id:uid(), date, acc, payee, cat:$('fcat').value, amt: type === 'in' ? amt : -amt, tr:false, ...(editing?.memo ? {memo:editing.memo} : {})}];
  }
  if (editing && !editing.tr && type !== 'tr' && editing.cat !== $('fcat').value) { RULES[payee.toLowerCase()] = $('fcat').value; DB.set('rules', RULES); }
  try {
    await saveTx(add, editing ? oldIds(editing) : []);
    selK = date.slice(0, 7); sheet.classList.remove('open');
    toast(editing ? 'Änderung gespeichert' : 'Buchung gespeichert'); editing = null; render();
  } catch (err) { toast('Speichern fehlgeschlagen'); console.error(err); }
};
let delArm = 0;
$('fdel').onclick = async () => {
  if (!editing) return;
  if (Date.now() - delArm > 2500) { delArm = Date.now(); $('fdel').textContent = 'Nochmal tippen zum Löschen'; setTimeout(() => $('fdel').textContent = 'Buchung löschen', 2500); return; }
  await saveTx([], oldIds(editing)); editing = null; sheet.classList.remove('open'); toast('Buchung gelöscht'); render();
};

// ============ Mehr / Einstellungen ============
async function openMore() {
  $('starts').innerHTML = ACC.map(a => `<div class="set"><div>${a.name}<small>${a.sub}</small></div><input inputmode="decimal" data-start="${a.id}" value="${START[a.id] ? String(START[a.id]).replace('.', ',') : ''}" placeholder="0,00"></div>`).join('');
  $('lastbk').textContent = lastBackup ? 'Zuletzt am ' + new Date(lastBackup).toLocaleDateString('de-DE') : 'Noch nie gesichert';
  $('demorow').hidden = TX.length > 0; $('impok').hidden = true;
  let p = 'Nicht verfügbar';
  try { if (navigator.storage?.persisted) p = (await navigator.storage.persisted()) ? 'Aktiv: Der Browser löscht die Daten nicht automatisch' : 'Nicht aktiv: Bitte App zum Home-Bildschirm hinzufügen und regelmäßig sichern'; } catch {}
  $('persist').textContent = p;
  more.classList.add('open');
}
$('starts').addEventListener('change', async e => {
  const i = e.target.closest('[data-start]'); if (!i) return;
  const v = parseFloat(i.value.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  START[i.dataset.start] = isNaN(v) ? 0 : r2(v);
  await DB.set('start', START); render(); toast('Startsaldo gespeichert');
});
$('bexp').onclick = async () => {
  const data = JSON.stringify({app:'finanzen', v:1, exported:new Date().toISOString(), start:START, dismissed:[...dismissed], tx:TX.map(strip)}, null, 1);
  const name = `finanzen-backup-${iso(today())}.json`, file = new File([data], name, {type:'application/json'});
  try {
    if (navigator.canShare && navigator.canShare({files:[file]})) await navigator.share({files:[file], title:'Finanzen Backup'});
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
    lastBackup = new Date().toISOString(); await DB.set('lastBackup', lastBackup);
    $('lastbk').textContent = 'Zuletzt am ' + new Date(lastBackup).toLocaleDateString('de-DE'); render(); toast('Backup erstellt');
  } catch (err) { if (err.name !== 'AbortError') toast('Backup fehlgeschlagen'); }
};
let pending = null;
$('bimp').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'finanzen' || !Array.isArray(j.tx)) throw new Error('format');
    const ok = j.tx.filter(t => t && typeof t.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && AC[t.acc] && typeof t.amt === 'number' && typeof t.payee === 'string' && typeof t.cat === 'string');
    pending = {...j, tx: ok};
    $('impinfo').textContent = `${ok.length} Buchungen vom ${new Date(j.exported).toLocaleDateString('de-DE')}`; $('impok').hidden = false;
  } catch { toast('Das ist keine gültige Backup-Datei'); }
};
$('impgo').onclick = async () => {
  if (!pending) return;
  await DB.clear(); TX = [];
  await saveTx(pending.tx.map(t => ({id:t.id, date:t.date, acc:t.acc, payee:t.payee, cat:t.cat, amt:t.amt, tr:!!t.tr, ...(t.g ? {g:String(t.g)} : {})})));
  if (pending.start) { ACC.forEach(a => START[a.id] = +pending.start[a.id] || 0); await DB.set('start', START); }
  dismissed = new Set(Array.isArray(pending.dismissed) ? pending.dismissed.map(String) : []); await DB.set('dismissed', [...dismissed]);
  pending = null; more.classList.remove('open'); selK = key(today()); render(); toast('Backup wiederhergestellt');
};
let wipeArm = 0;
$('wipe').onclick = async () => {
  const b = $('wipe');
  if (Date.now() - wipeArm > 3000) { wipeArm = Date.now(); b.classList.add('arm'); b.textContent = 'Sicher?'; setTimeout(() => { b.classList.remove('arm'); b.textContent = 'Löschen'; }, 3000); return; }
  await DB.clear(); TX = []; START = {giro:0, mm:0, c24:0, tr:0}; dismissed = new Set();
  await DB.set('start', START); await DB.set('dismissed', []);
  more.classList.remove('open'); render(); toast('Alle Daten gelöscht');
};
$('demo').onclick = () => loadDemo();

// ============ CSV-Import ============
const isheet = $('impsheet');
function closeAll() { [sheet, more, isheet].forEach(x => x.classList.remove('open')); editing = null; }
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
function decode(buf) { try { return new TextDecoder('utf-8', {fatal:true}).decode(buf).replace(/^﻿/, ''); } catch { return new TextDecoder('windows-1252').decode(buf); } }
function detectDelim(text) {
  const head = text.split(/\r?\n/).slice(0, 20).join('\n');
  return [';', ',', '\t', '|'].map(d => [d, head.split(d).length]).sort((a,b) => b[1] - a[1])[0][0];
}
function parseCSV(text, d) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
}
function num(s) {
  s = String(s ?? '').replace(/EUR|€|\s| /gi, '').replace(/−/g, '-'); if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const v = parseFloat(s); return neg ? -v : v;
}
function pdate(s) {
  s = (s || '').trim(); let m, y, mo, d;
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { y = +m[3]; mo = +m[1]; d = +m[2]; }
  else return null;
  const dt = new Date(y, mo - 1, d, 12);
  return dt.getMonth() === mo - 1 && dt.getDate() === d ? iso(dt) : null;
}
const FIELDS = [['date','Datum'],['amount','Betrag'],['debit','Soll / Ausgang'],['credit','Haben / Eingang'],['payee','Empfänger / Auftraggeber'],['purpose','Verwendungszweck']];
const KW = {
  date: [/^buchungs?tag$/i, /buchungsdatum/i, /^datum$/i, /^date$/i, /buchung/i, /datum|date/i, /valuta|wertstellung/i],
  amount: [/^betrag/i, /^amount/i, /^umsatz/i, /betrag|amount/i],
  debit: [/^soll\b|belastung|^ausgang/i], credit: [/^haben\b|gutschrift|^eingang/i],
  payee: [/beg(ue|ü)nstigter|zahlungspflichtiger/i, /empf(ae|ä)nger|auftraggeber/i, /^name$/i, /h(ä|ae)ndler|merchant|gegenkonto.*name|partner/i, /beschreibung|description/i],
  purpose: [/verwendungszweck/i, /buchungstext/i, /beschreibung|description|details|zweck|^info|referenz/i]
};
function autoMap(h) {
  const m = {}, used = new Set();
  for (const [k] of FIELDS) for (const re of KW[k]) { const i = h.findIndex((x, j) => !used.has(j) && re.test(x)); if (i >= 0) { m[k] = i; used.add(i); break; } }
  if (m.amount !== undefined) { delete m.debit; delete m.credit; }
  return m;
}
const BUILTIN = [
  [/rewe|edeka|lidl|aldi|netto|penny|kaufland|norma|tegut|globus|nahkauf|bäcker|baecker/i, 'Lebensmittel'],
  [/aral|shell|esso|\bjet\b|totalenergies|tankstelle|deutsche bahn|db vertrieb|db fernverkehr|bvg|mvg|hvv|\buber\b|bolt|flixbus|parkhaus|parken|easypark/i, 'Mobilität'],
  [/netflix|spotify|disney|dazn|\bsky\b|apple\.com|icloud|youtube|prime video|audible|vodafone|telekom|\bo2\b|congstar|1&1|chatgpt|openai|anthropic/i, 'Abos'],
  [/media ?markt|saturn|cyberport|notebooksbilliger|apple store/i, 'Elektronik'],
  [/amazon|amzn|zalando|\botto\b|ebay|ikea|h&m|zara|paypal/i, 'Shopping'],
  [/\bdm\b|dm-drogerie|rossmann|drogerie m(ü|ue)ller/i, 'Drogerie'],
  [/miete|hausverwaltung|wohnungs|stadtwerke|strom|\bgas\b|rundfunk|ard zdf|nebenkosten/i, 'Wohnen'],
  [/versicherung|\bhuk\b|allianz|\baxa\b|\bergo\b|devk|r\+v|signal iduna|krankenkasse/i, 'Versicherung'],
  [/apotheke|arzt|zahnarzt|praxis|klinik|optiker/i, 'Gesundheit'],
  [/lieferando|wolt|mcdonald|burger king|restaurant|pizzeria|trattoria|caf(é|e)\b|starbucks|\bkfc\b|subway|döner|doener|imbiss/i, 'Restaurants'],
  [/fitx|mcfit|urban sports|fitness|\bgym\b|sportverein/i, 'Sport'],
  [/booking\.com|airbnb|lufthansa|eurowings|ryanair|condor|hotel|expedia/i, 'Urlaub'],
  [/kino|cinema|cinemaxx|eventim|steam|playstation|nintendo|xbox/i, 'Freizeit']];
const IN_BUILTIN = [[/lohn|gehalt|bez(ü|ue)ge|salary|entgelt/i, 'Gehalt'], [/zins|interest/i, 'Zinsen']];
const OWN = {giro:/sparkasse/i, mm:/miles ?(&|and|und) ?more|kreditkartenabrechnung|kreditkarte/i, c24:/\bc24\b/i, tr:/trade republic/i};
const XFER = /umbuchung|übertrag|uebertrag|eigenes konto|eigene konten|sparplan|einzahlung trade/i;
function categorize(payee, memo, amt) {
  const p = payee.toLowerCase(), isIn = amt > 0, fits = c => c && IN_CATS.includes(c) === isIn;
  if (fits(RULES[p])) return RULES[p];
  const prev = [...TX].reverse().find(t => !t.tr && t.payee.toLowerCase() === p && (t.amt > 0) === isIn);
  if (prev) return prev.cat;
  const s = payee + ' ' + memo;
  for (const [re, c] of (isIn ? IN_BUILTIN : BUILTIN)) if (re.test(s)) return c;
  return isIn ? 'Sonstige Einnahme' : 'Sonstiges';
}
const dayDiff = (a, b) => Math.abs(new Date(a + 'T12:00') - new Date(b + 'T12:00')) / 864e5;
const fp = (acc, date, amt) => `${acc}|${date}|${amt.toFixed(2)}`;
const imp = {acc:'giro', mode:'csv', header:[], rows:[], raw:[], flip:new Set(), map:{}, inv:false, items:[], sig:''};

function openImport() {
  more.classList.remove('open');
  $('iacc').innerHTML = accOpts(filt || imp.acc); $('istep').hidden = true; imp.items = [];
  isheet.classList.add('open');
}
$('iacc').onchange = () => { imp.acc = $('iacc').value; if (imp.mode === 'csv' && imp.rows.length) { applySaved(); renderImport(); } else if (imp.mode === 'pdf' && imp.raw.length) renderImport(); };
$('ifile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  imp.acc = $('iacc').value;
  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') { try { await importPdf(f); } catch (err) { console.error(err); toast('PDF konnte nicht gelesen werden'); } return; }
  imp.mode = 'csv'; imp.pdfLines = null;
  try {
    const text = decode(await f.arrayBuffer()), d = detectDelim(text), rows = parseCSV(text, d);
    let hi = rows.slice(0, 40).findIndex(r => r.length >= 3 && r.some(x => /datum|date|buchung|tag/i.test(x)) && r.some(x => /betrag|amount|umsatz|soll|haben/i.test(x)));
    if (hi < 0) hi = 0;
    imp.header = rows[hi].map(clean); imp.rows = rows.slice(hi + 1).filter(r => r.length >= Math.min(3, imp.header.length));
    imp.sig = imp.header.join('|').toLowerCase(); imp.acc = $('iacc').value;
    if (!imp.rows.length) throw new Error('leer');
    applySaved(); renderImport(); $('istep').hidden = false;
  } catch (err) { console.error(err); toast('Datei konnte nicht gelesen werden'); }
};
function applySaved() {
  const saved = MAPS[imp.acc];
  if (saved && saved.sig === imp.sig) { imp.map = {...saved.map}; imp.inv = !!saved.inv; return; }
  imp.map = autoMap(imp.header); imp.inv = false;
  const amts = buildRaw().map(x => x.amt); // Kreditkarten-Exporte führen Ausgaben oft positiv
  imp.inv = amts.length >= 5 && amts.filter(a => a > 0).length / amts.length > .8;
}
function buildRaw() {
  if (imp.mode === 'pdf') return imp.raw.map((x, ri) => ({date:x.date, amt:r2(x.amt * (imp.inv ? -1 : 1) * (imp.flip.has(ri) ? -1 : 1)), payee:x.payee, memo:x.memo, acc:imp.acc, ri, sure:x.sure}));
  const {map, inv, acc} = imp, out = [], g = (r, k) => map[k] !== undefined ? r[map[k]] : undefined;
  for (const r of imp.rows) {
    const date = pdate(g(r, 'date')); let amt;
    if (map.amount !== undefined) amt = num(g(r, 'amount'));
    else { const d = num(g(r, 'debit')), c = num(g(r, 'credit')); amt = isNaN(d) && isNaN(c) ? NaN : (isNaN(c) ? 0 : Math.abs(c)) - (isNaN(d) ? 0 : Math.abs(d)); }
    if (!date || isNaN(amt) || amt === 0) continue;
    if (inv) amt = -amt;
    const memo = clean(g(r, 'purpose')), payee = clean(g(r, 'payee')) || memo.slice(0, 40) || 'Unbekannt';
    out.push({date, amt:r2(amt), payee, memo, acc});
  }
  return out;
}
function analyse() {
  const raw = buildRaw(), counts = {};
  TX.forEach(t => { const k = fp(t.acc, t.date, t.amt); counts[k] = (counts[k] || 0) + 1; });
  const used = new Set(), keep = {};
  imp.items.forEach(x => { if (x.catSet) keep[x.payee.toLowerCase() + (x.amt > 0)] = x.cat; });
  imp.items = raw.map(x => {
    const k = fp(x.acc, x.date, x.amt);
    if (counts[k]) { counts[k]--; return {...x, dup:true}; }
    const text = x.payee + ' ' + x.memo;
    const kw = XFER.test(text) || Object.entries(OWN).some(([id, re]) => id !== x.acc && re.test(text)) || (x.acc === 'tr' && x.amt < 0 && /handel|\bkauf\b|sparplan|wertpapier|order/i.test(text));
    const cp = TX.find(t => !used.has(t.id) && t.acc !== x.acc && Math.abs(t.amt + x.amt) < .005 && dayDiff(t.date, x.date) <= 4 && (t.tr ? t.lone : kw));
    if (cp) used.add(cp.id);
    if (kw || cp) return {...x, tr:true, pair: cp ? cp.id : null};
    const kc = keep[x.payee.toLowerCase() + (x.amt > 0)];
    return {...x, cat: kc || categorize(x.payee, x.memo, x.amt), catSet: !!kc};
  });
}
function renderImport() {
  const isPdf = imp.mode === 'pdf';
  $('icsv').hidden = isPdf; $('ipdf').hidden = !isPdf; $('idiagtxt').hidden = true;
  $('imap').innerHTML = FIELDS.map(([k, l]) => `<div><label for="m_${k}">${l}</label><select id="m_${k}" data-map="${k}"><option value="">–</option>${imp.header.map((h, i) => `<option value="${i}"${imp.map[k] === i ? ' selected' : ''}>${esc(h || 'Spalte ' + (i + 1))}</option>`).join('')}</select></div>`).join('');
  $('iinv').checked = imp.inv;
  analyse();
  const nw = imp.items.filter(x => !x.dup), dup = imp.items.length - nw.length, trn = nw.filter(x => x.tr).length;
  if (isPdf) {
    const {opening, closing} = imp.bal, sum = r2(imp.items.reduce((s, x) => s + x.amt, 0)), unsure = imp.items.filter(x => !x.sure).length;
    let msg = '';
    if (opening !== null && closing !== null) { const diff = r2(closing - opening - sum); msg = Math.abs(diff) < .01 ? `✓ Kontostand-Probe passt: ${eur.format(opening)} → ${eur.format(closing)}` : `⚠ Abweichung von ${eur.format(diff)} zur Kontostand-Probe. Tippe auf einen Betrag, um sein Vorzeichen zu ändern.`; }
    else msg = 'Kein Anfangs-/Endsaldo gefunden – bitte Beträge kurz prüfen.';
    if (unsure) msg += ` ${unsure} Vorzeichen geschätzt (markiert).`;
    $('icheck').textContent = msg;
  }
  $('isum').textContent = imp.items.length ? `${nw.length} neu · ${trn} Umbuchungen · ${dup} schon vorhanden` : isPdf ? 'Keine Buchungen erkannt – nutze „Struktur anonym kopieren“ und schick mir den Text' : 'Keine Buchungen erkannt – bitte Spalten prüfen';
  const outCats = OUT_CATS.map(c => [c, c]), inCats = IN_CATS.map(c => [c, c]);
  $('ilist').innerHTML = nw.slice(0, 150).map((x, i) => `<div class="row irow"><div class="t"><b>${esc(x.payee)}</b><small>${new Date(x.date + 'T12:00').toLocaleDateString('de-DE')} · ${isPdf ? `<button type="button" class="chip" data-flip="${x.ri}" style="${x.sure ? '' : 'box-shadow:0 0 0 2px #e0a87a;'}padding:2px 8px" aria-label="Vorzeichen ändern"><span class="${x.amt > 0 ? 'pos' : ''}">${eur.format(x.amt)}</span> ±</button>` : `<span class="${x.amt > 0 ? 'pos' : ''}">${eur.format(x.amt)}</span>`}</small></div>${x.tr ? `<span class="chip">Umbuchung</span>` : `<select data-icat="${imp.items.indexOf(x)}" aria-label="Kategorie">${opt(x.amt > 0 ? inCats : outCats, x.cat)}</select>`}</div>`).join('')
    + (nw.length > 150 ? `<div class="empty">… und ${nw.length - 150} weitere</div>` : '');
  $('igo').disabled = !nw.length; $('igo').textContent = nw.length ? `${nw.length} Buchungen importieren` : 'Nichts zu importieren';
}
$('imap').addEventListener('change', e => { const s = e.target.closest('[data-map]'); if (!s) return; if (s.value === '') delete imp.map[s.dataset.map]; else imp.map[s.dataset.map] = +s.value; renderImport(); });
$('iinv').onchange = () => { imp.inv = $('iinv').checked; renderImport(); };
$('ilist').addEventListener('change', e => {
  const s = e.target.closest('[data-icat]'); if (!s) return;
  const it = imp.items[+s.dataset.icat], p = it.payee.toLowerCase(), isIn = it.amt > 0;
  imp.items.forEach(x => { if (!x.dup && !x.tr && x.payee.toLowerCase() === p && (x.amt > 0) === isIn) { x.cat = s.value; x.catSet = true; } });
  RULES[p] = s.value; renderImport();
});
$('igo').onclick = async () => {
  const nw = imp.items.filter(x => !x.dup); if (!nw.length) return;
  const add = [], upd = [];
  for (const x of nw) {
    const t = {id:uid(), date:x.date, acc:x.acc, payee:x.payee, cat:x.tr ? 'Umbuchung' : x.cat, amt:x.amt, tr:!!x.tr, ...(x.memo ? {memo:x.memo} : {})};
    if (x.tr) {
      const cp = x.pair && TX.find(y => y.id === x.pair);
      if (cp) { t.g = cp.g && cp.lone ? cp.g : uid(); upd.push({...strip(cp), tr:true, cat:'Umbuchung', g:t.g, lone:false}); }
      else { t.g = uid(); t.lone = true; }
    }
    add.push(t);
  }
  try {
    await saveTx([...add, ...upd], upd.map(u => u.id));
    if (imp.mode === 'csv') { MAPS[imp.acc] = {sig:imp.sig, map:imp.map, inv:imp.inv}; await DB.set('maps', MAPS); } await DB.set('rules', RULES);
    selK = add.map(t => t.date).sort().pop().slice(0, 7);
    imp.rows = []; imp.raw = []; imp.pdfLines = null; imp.items = []; isheet.classList.remove('open'); render();
    toast(`${add.length} Buchungen importiert`);
  } catch (err) { console.error(err); toast('Import fehlgeschlagen'); }
};

// ============ PDF-Import (läuft komplett lokal auf dem Gerät) ============
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', location.href).href;
  return pdfjs;
}
const AMT_RE = /([+-]?\s?\d{1,3}(?:\.\d{3})*,\d{2}|[+-]?\s?\d+,\d{2})(\s?[+-](?!\d)|\s?\b[SH]\b)?/g;
const MON = {jan:1, feb:2, mär:3, mrz:3, mar:3, apr:4, mai:5, jun:6, jul:7, aug:8, sep:9, okt:10, nov:11, dez:12};
const SKIP = /kontostand|saldo|übertrag|uebertrag|zwischensumme|summe der|^seite\b|blatt\s*\d|rechnungsabschluss|kreditlinie|verfügungsrahmen/i;
const OPEN_RE = /(alter|letzter|anfangs|vorheriger)\s*(kontostand|saldo)|saldovortrag|anfangssaldo/i;
const CLOSE_RE = /(neuer|aktueller|end)\s*(kontostand|saldo)|endsaldo/i;
const BTYPE = /^(sepa[- ]?)?(basis[- ]?)?(lastschrift|überweisungsgutschrift|gutschrift|echtzeitüberweisung|echtzeit-überweisung|überweisung|ueberweisung|dauerauftrag|kartenzahlung girocard|kartenzahlung|kartenumsatz|girocard|einzug|abbuchung|bargeldauszahlung|auszahlung|einzahlung|zinsen|entgelt|gebühr|gebuehr|lohn\/gehalt|gehalt\/rente|überweisungsgutschrift|retoure|zahlung)\b[\s:.-]*/i;
const POS_WORDS = /gutschrift|eingang|lohn|gehalt|rente|zinsen|erstattung|einzahlung|retoure|rückzahlung|rueckzahlung/i;
const IN_HEAD = /^(haben|gutschrift|eingang|zahlungseingang|einnahmen?)$/i, OUT_HEAD = /^(soll|belastung|lastschrift|ausgang|zahlungsausgang|ausgaben?)$/i, BAL_HEAD = /^(saldo|kontostand)$/i;

async function readPdfLines(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported:false}).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({s:i.str, x:i.transform[4], y:i.transform[5], w:i.width || 0}));
    items.sort((a,b) => b.y - a.y || a.x - b.x);
    const pageLines = [];
    for (const it of items) {
      const ln = pageLines.find(l => Math.abs(l.y - it.y) < 3);
      if (ln) ln.items.push(it); else pageLines.push({y:it.y, page:p, items:[it]});
    }
    pageLines.forEach(l => { l.items.sort((a,b) => a.x - b.x); l.text = clean(l.items.map(i => i.s).join(' ')); });
    lines.push(...pageLines.sort((a,b) => b.y - a.y));
  }
  return lines;
}
function amountsOf(line) {
  const out = [];
  for (const it of line.items) {
    AMT_RE.lastIndex = 0; let m;
    while ((m = AMT_RE.exec(it.s))) {
      const raw = m[1].replace(/\s/g, ''), suf = (m[2] || '').trim();
      const before = it.s.slice(0, m.index);
      if (/\d[.,]?$/.test(before)) continue;
      let sign = raw.startsWith('-') ? -1 : raw.startsWith('+') ? 1 : 0;
      if (suf === '-' || suf === 'S') sign = -1; else if (suf === '+' || suf === 'H') sign = 1;
      const len = it.s.length || 1, cx = it.x + it.w * ((m.index + m[0].length / 2) / len);
      out.push({v:Math.abs(num(raw)), sign, cx, at: line.text.indexOf(m[1].trim())});
    }
  }
  return out.filter(a => a.v > 0 || a.v === 0);
}
function lineDate(text, endYear) {
  let m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?=\s|$)/);
  if (m) {
    let y = m[3] ? +m[3] : null; if (y && y < 100) y += 2000;
    return {d:+m[1], mo:+m[2], y, len:m[0].length};
  }
  m = text.match(/^(\d{1,2})\.?\s+([A-Za-zäÄ]{3})[a-zä]*\.?\s+(\d{4})?/);
  if (m && MON[m[2].toLowerCase()]) return {d:+m[1], mo:MON[m[2].toLowerCase()], y:m[3] ? +m[3] : null, len:m[0].length};
  return null;
}
function findHeader(lines) {
  for (const l of lines) {
    const cols = [];
    l.items.forEach(it => it.s.split(/\s{2,}/).forEach(w => { w = w.trim(); const cx = it.x + it.w / 2;
      if (IN_HEAD.test(w)) cols.push({k:'in', cx}); else if (OUT_HEAD.test(w)) cols.push({k:'out', cx}); else if (BAL_HEAD.test(w)) cols.push({k:'bal', cx}); }));
    if (cols.some(c => c.k !== 'bal') && cols.length >= 2) return cols;
  }
  return null;
}
function parsePdfLines(lines) {
  const full = lines.map(l => l.text).join('\n').match(/\b\d{1,2}\.\d{1,2}\.(\d{4})\b/g) || [];
  const fullDates = full.map(s => pdate(s)).filter(Boolean).sort();
  const endIso = fullDates[fullDates.length - 1] || iso(today()), endD = new Date(endIso + 'T12:00');
  const head = findHeader(lines), out = [];
  let cur = null, opening = null, closing = null;
  const finish = () => {
    if (!cur) return;
    if (!cur.payee) { cur.payee = cur.extra.shift() || 'Unbekannt'; }
    cur.memo = clean([cur.btype, ...cur.extra].join(' ')).slice(0, 200);
    cur.payee = cur.payee.slice(0, 60); delete cur.extra; delete cur.btype; out.push(cur); cur = null;
  };
  for (const l of lines) {
    const t = l.text, A = amountsOf(l);
    if (A.length && (OPEN_RE.test(t) || CLOSE_RE.test(t) || /(kontostand|saldo)\s+(am|per|zum)\b/i.test(t))) {
      const a = A[A.length-1], v = a.v * (a.sign || 1);
      if (CLOSE_RE.test(t) || (opening !== null && !OPEN_RE.test(t))) closing = v; else if (opening === null) opening = v;
    }
    const dt = lineDate(t);
    if (dt && A.length && !SKIP.test(t)) {
      finish();
      let y = dt.y || endD.getFullYear(), dd = new Date(y, dt.mo - 1, dt.d, 12);
      if (!dt.y && dd - endD > 7 * 864e5) dd = new Date(y - 1, dt.mo - 1, dt.d, 12);
      if (dd.getMonth() !== dt.mo - 1) continue;
      let cand = A, kind = null;
      if (head) {
        const cls = A.map(a => ({...a, k: head.reduce((b, c) => Math.abs(c.cx - a.cx) < Math.abs(b.cx - a.cx) ? c : b).k}));
        const tx = cls.filter(a => a.k !== 'bal'); if (tx.length) { cand = tx; kind = tx[0].k; }
      } else if (A.length > 1) cand = [A[A.length - 2]];
      const a = cand[0];
      let desc = t.slice(dt.len, a.at > dt.len ? a.at : undefined).trim();
      desc = desc.replace(/^\d{1,2}\.\d{1,2}\.(\d{2,4})?\s*/, '');
      const bt = desc.match(BTYPE); const btype = bt ? bt[0].trim() : '';
      if (bt) desc = desc.slice(bt[0].length);
      let sign = a.sign, sure = true;
      if (!sign && kind) sign = kind === 'in' ? 1 : -1;
      if (!sign) { sign = POS_WORDS.test(btype + ' ' + desc) ? 1 : -1; sure = false; }
      cur = {date: iso(dd), amt: r2(a.v * sign), payee: clean(desc), btype, extra: [], sure};
    } else if (cur && !A.length && !SKIP.test(t) && !lineDate(t) && cur.extra.length < 4 && t.length < 120) {
      cur.extra.push(t);
    } else if (cur && (SKIP.test(t) || A.length)) finish();
  }
  finish();
  return {rows: out, opening, closing};
}
// Anonymisierte Struktur: nur Layout, keine echten Werte
const KEEP = /^(datum|buchungstag|buchung|valuta|wert|wertstellung|betrag|umsatz|soll|haben|eur|saldo|kontostand|alter|neuer|übertrag|lastschrift|gutschrift|überweisung|kartenzahlung|dauerauftrag|sepa|basislastschrift|zahlungseingang|zahlungsausgang|eingang|ausgang|typ|beschreibung|verwendungszweck|seite|von|bis|am|kontoauszug|umsätze|zinsen|gebühr|entgelt|belastung|einzahlung|auszahlung|summe)$/i;
function anonymize(lines) {
  return lines.slice(0, 120).map(l => `[p${l.page} y${Math.round(l.y)}] ` + l.items.map(it => `@${Math.round(it.x)} ` + it.s.split(/(\s+)/).map(w => KEEP.test(w.replace(/[:.]$/, '')) ? w : w.replace(/\d/g, '9').replace(/[A-ZÄÖÜ]/g, 'X').replace(/[a-zäöüß]/g, 'x')).join('')).join('  ')).join('\n');
}
async function importPdf(f) {
  toast('PDF wird gelesen …');
  const lines = await readPdfLines(f), res = parsePdfLines(lines);
  imp.mode = 'pdf'; imp.pdfLines = lines; imp.raw = res.rows; imp.flip = new Set(); imp.bal = res;
  imp.sig = 'pdf'; imp.inv = false; imp.header = []; imp.rows = [];
  if (!lines.length) toast('In der PDF wurde kein Text gefunden (evtl. eingescannt)');
  renderImport(); $('istep').hidden = false;
}
$('idiag').onclick = async () => {
  if (!imp.pdfLines) return;
  const txt = anonymize(imp.pdfLines);
  try { await navigator.clipboard.writeText(txt); toast('Anonyme Struktur kopiert'); }
  catch { $('idiagtxt').hidden = false; $('idiagtxt').value = txt; $('idiagtxt').select(); toast('Text markiert – bitte kopieren'); }
};
$('ilist').addEventListener('click', e => {
  const b = e.target.closest('[data-flip]'); if (!b) return;
  const i = +b.dataset.flip; imp.flip.has(i) ? imp.flip.delete(i) : imp.flip.add(i); renderImport();
});

// ============ Beispieldaten ============
async function loadDemo() {
  if (TX.length) { toast('Nur bei leerer App möglich'); return; }
  let sd = 7; const r = () => { sd = sd + 0x6D2B79F5 | 0; let t = Math.imul(sd ^ sd >>> 15, 1 | sd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rr = (a,b) => a + r()*(b-a), ri = (a,b) => Math.floor(rr(a, b+1)), pick = a => a[Math.floor(r()*a.length)];
  const T = today(), out = [];
  const add = (y,m,day,acc,payee,cat,amt,tr,g) => { const d = new Date(y, m, Math.min(day, new Date(y, m+1, 0).getDate()), 12); if (d > T) return; out.push({id:uid(), date:iso(d), acc, payee, cat, amt:r2(amt), tr:!!tr, ...(g ? {g} : {})}); };
  const move = (y,m,day,a,b,amt,l) => { const g = uid(); add(y,m,day,a,l,'Umbuchung',-amt,1,g); add(y,m,day,b,l,'Umbuchung',amt,1,g); };
  const SAL = [3120,3580,3290,3910,3350,3020,3760,3440,3180,4120,3310,3530];
  let open = 0;
  for (let i = 11; i >= 0; i--) {
    const b = new Date(T.getFullYear(), T.getMonth() - i, 1), y = b.getFullYear(), m = b.getMonth(), n0 = out.length;
    if (open > 0) move(y,m,2,'giro','mm',r2(open),'Kreditkartenabrechnung');
    add(y,m,25,'giro','Arbeitgeber GmbH','Gehalt',SAL[11-i]);
    add(y,m,1,'giro','Hausverwaltung Kern','Wohnen',-1290);
    if (i !== 0) add(y,m,15,'giro','Stadtwerke Strom','Wohnen',-92);
    add(y,m,5,'giro','Vodafone','Abos',-39.99);
    add(y,m,3,'mm','Netflix','Abos',-13.99);
    add(y,m,8,'mm','Spotify','Abos', i < 3 ? -11.99 : -10.99);
    add(y,m,4,'c24','FitX Studio','Sport',-29.9);
    if (m % 3 === 0) add(y,m,10,'giro','HUK Kfz-Versicherung','Versicherung',-186.4);
    move(y,m,2,'giro','c24',450,'Haushaltsgeld');
    move(y,m,3,'giro','tr',500,'Sparplan');
    add(y,m,28,'tr','Trade Republic Zinsen','Zinsen',rr(17,26));
    for (let k = ri(6,9); k--;) add(y,m,ri(1,28), r() < .55 ? 'c24' : 'giro', pick(['REWE','Edeka','Lidl','Aldi Süd']),'Lebensmittel',-rr(18,92));
    for (let k = ri(2,3); k--;) add(y,m,ri(1,28),'mm',pick(['Aral','Shell','Jet']),'Mobilität',-rr(55,86));
    for (let k = ri(2,4); k--;) add(y,m,ri(1,28),'mm',pick(['Trattoria Roma','Sushi Ya','Café Lumen','Burgerei']),'Restaurants',-rr(18,68));
    for (let k = ri(1,3); k--;) add(y,m,ri(1,28),'mm','Amazon','Shopping',-rr(14,79));
    for (let k = ri(1,2); k--;) add(y,m,ri(1,28),'c24','dm','Drogerie',-rr(9,36));
    if (i === 0) { add(y,m,Math.min(T.getDate(),19),'mm','MediaMarkt','Elektronik',-1299); add(y,m,Math.min(T.getDate(),12),'mm','Trattoria Roma','Restaurants',-212.5); }
    open = -out.slice(n0).filter(t => t.acc === 'mm' && !t.tr).reduce((s,t) => s + t.amt, 0);
  }
  START = {giro:1200, mm:0, c24:900, tr:8500}; await DB.set('start', START);
  await saveTx(out); more.classList.remove('open'); selK = key(today()); render(); toast('Beispieldaten geladen');
}

// ============ Navigation & Klicks ============
$('prev').onclick = () => { const MK = monthKeys(), i = MK.indexOf(selK); if (i > 0) { selK = MK[i-1]; render(); } };
$('next').onclick = () => { const MK = monthKeys(), i = MK.indexOf(selK); if (i < MK.length - 1) { selK = MK[i+1]; render(); } };
$('chip').onclick = () => { filt = null; render(); };
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-close]') || t === sheet || t === more || t === isheet) { closeAll(); return; }
  const a = t.closest('[data-acc]'); if (a) { filt = filt === a.dataset.acc ? null : a.dataset.acc; render(); if (filt) toast('Gefiltert: ' + AC[filt].name); return; }
  const d = t.closest('[data-dis]'); if (d) { dismissed.add(d.dataset.dis); await DB.set('dismissed', [...dismissed]); render(); return; }
  const r = t.closest('[data-tx]'); if (r) { const x = TX.find(y => y.id === r.dataset.tx); if (x) openForm(x); return; }
  const act = t.closest('[data-act]'); if (act) { const v = act.dataset.act; if (v === 'new') openForm(); else if (v === 'import') openImport(); else if (v === 'more') openMore(); else if (v === 'demo') loadDemo(); return; }
  const g = t.closest('[data-go]'); if (g) {
    const v = g.dataset.go;
    if (v === 'more') openMore();
    else if (v === 'top') scrollTo({top:0, behavior: RM ? 'auto' : 'smooth'});
    else $(v).scrollIntoView({behavior: RM ? 'auto' : 'smooth', block:'start'});
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

// ============ Start ============
(async () => {
  try {
    await DB.open();
    TX = (await DB.all()).map(hydrate);
    START = {...START, ...((await DB.get('start')) || {})};
    dismissed = new Set((await DB.get('dismissed')) || []);
    lastBackup = (await DB.get('lastBackup')) || null;
    RULES = (await DB.get('rules')) || {}; MAPS = (await DB.get('maps')) || {};
  } catch (err) { console.error(err); toast('Speicher nicht verfügbar – Daten werden nicht gesichert'); }
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
}
