/* Well Closure Field App v0.1
   Map and search reuse the Alberta Well Closure Atlas data format:
   wells_b64.txt  13-byte records: lon f32, lat f32, status u8, flags u8, licensee u16, fluid u8
                  flags: 1 nominated, 2 any leak report, 4 open leak report, 8 open and serious
   wells_ids.txt  one line per well: licence,surface location
   wells_meta.json  licensees, fluids, status names, vf (leak report detail keyed by row)
   Site records live in IndexedDB on the device (store "sites", keyed by licence). */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString("en-CA");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
const STAGES = window.CHECKLISTS;
const STATUS_TXT = {Abandoned:"Decommissioned, awaiting reclamation", RecCertified:"Reclamation certified", RecExempt:"Reclamation exempt", Suspension:"Suspended", "Re-Entered":"Re-entered", Issued:"Issued", Amended:"Amended"};
const GROUP_COL = ["var(--s-aband)","var(--s-cert)","var(--s-exempt)","var(--s-other)"];

function toast(t){ const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600); }

/* ================= storage ================= */
const DB = (() => {
  let dbp = null;
  const open = () => dbp ||= new Promise((res, rej) => {
    try {
      const r = indexedDB.open("well-field-app", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sites", {keyPath:"licence"});
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("sites", mode); const st = t.objectStore("sites"); const out = fn(st); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined); t.onerror = () => rej(t.error); }); };
  return {
    get: lic => tx("readonly", s => s.get(lic)),
    all: () => tx("readonly", s => s.getAll()),
    put: rec => tx("readwrite", s => { s.put(rec); }),
    del: lic => tx("readwrite", s => { s.delete(lic); }),
  };
})();
let mySites = new Map(); // licence -> summary
async function refreshSites(){
  try { const all = await DB.all(); mySites = new Map(all.map(r => [r.licence, r])); }
  catch { mySites = new Map(); }
  $("siteCount").textContent = mySites.size;
  markMine(); draw();
}

/* ================= map ================= */
const css = () => { const s = getComputedStyle(document.documentElement); const g = k => s.getPropertyValue(k).trim(); return {
  land:g("--land"), edge:g("--land-edge"), water:g("--water"), ink:g("--ink"), panel:g("--panel"), muted:g("--muted"),
  aband:g("--s-aband"), cert:g("--s-cert"), exempt:g("--s-exempt"), other:g("--s-other"), nom:g("--nom"), vent:g("--vent"), mine:g("--mine"), me:g("--me") }; };
let C = css();
const rgb = c => { const x = document.createElement("canvas").getContext("2d"); x.fillStyle = c; const h = x.fillStyle; if (h[0] === "#") return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]; return h.match(/\d+/g).slice(0,3).map(Number); };

const LAYERS = [
  {id:"aband", label:"Awaiting reclamation", sw:"--s-aband", on:true},
  {id:"done", label:"Certified or exempt", sw:"--s-cert", on:false},
  {id:"nom", label:"Nominated", sw:"--nom", on:true, ring:true},
  {id:"vent", label:"Open leak report", sw:"--vent", on:true, ring:true},
  {id:"mine", label:"My sites", sw:"--mine", on:true, ring:true},
];
const on = Object.fromEntries(LAYERS.map(l => [l.id, l.on]));
let W = null, ids = null, base = null, idsReady = null;
let mineIdx = new Set();
let me = null; // {lat, lon, acc}
let selected = -1, highlightLic = -1;
const view = {cx:0, cy:0, s:1};
const KX = Math.cos(54.5*Math.PI/180);
const proj = (lon, lat) => [lon*KX, -lat];
const cv = $("map"), ctx = cv.getContext("2d");
let dpr = 1, cw = 0, ch = 0, raf = 0;

function resize(){ const r = cv.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio||1, 2); cw = Math.max(1, Math.round(r.width*dpr)); ch = Math.max(1, Math.round(r.height*dpr)); cv.width = cw; cv.height = ch; draw(); }
function fitAlberta(){ const [x0,y0] = proj(-120.1, 60.05), [x1,y1] = proj(-109.9, 48.95); view.cx = (x0+x1)/2; view.cy = (y0+y1)/2; view.s = Math.min(cw/(x1-x0), ch/(y1-y0))*0.94; }
const toScreen = (x, y) => [(x-view.cx)*view.s + cw/2, (y-view.cy)*view.s + ch/2];
const toWorld = (px, py) => [(px-cw/2)/view.s + view.cx, (py-ch/2)/view.s + view.cy];
function draw(){ if (!raf) raf = requestAnimationFrame(render); }
const isShown = i => { const g = W.grp[i], f = W.flags[i];
  return (g===0 && on.aband) || (g!==0 && on.done) || (on.nom && f&1) || (on.vent && f&4) || (on.mine && mineIdx.has(i)); };

function render(){
  raf = 0; if (!cw) return;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = C.water; ctx.fillRect(0,0,cw,ch);
  if (base){ ctx.beginPath();
    for (const ring of base.rings){ ring.forEach((p,k) => { const [x,y] = toScreen(...proj(p[0],p[1])); k ? ctx.lineTo(x,y) : ctx.moveTo(x,y); }); ctx.closePath(); }
    ctx.fillStyle = C.land; ctx.fill("evenodd"); ctx.lineWidth = dpr; ctx.strokeStyle = C.edge; ctx.stroke(); }
  if (!W) return;
  const img = ctx.getImageData(0,0,cw,ch), buf = new Uint32Array(img.data.buffer);
  const z = view.s/dpr, sz = z > 900 ? 5 : z > 300 ? 3 : z > 120 ? 2 : 1, half = sz>>1;
  const pack = c => { const [r,g,b] = rgb(c); return (255<<24)|(b<<16)|(g<<8)|r; };
  const col = [pack(C.aband), pack(C.cert), pack(C.exempt), pack(C.other)];
  const put = (px, py, c) => { for (let dy=-half; dy<sz-half; dy++){ const yy = py+dy; if (yy<0||yy>=ch) continue; const row = yy*cw; for (let dx=-half; dx<sz-half; dx++){ const xx = px+dx; if (xx>=0&&xx<cw) buf[row+xx] = c; } } };
  const n = W.n; W.sx ||= new Float32Array(n); W.sy ||= new Float32Array(n); W.vis ||= new Uint8Array(n);
  let inView = 0; const rings = [];
  for (let i=0;i<n;i++){
    const x = (W.x[i]-view.cx)*view.s + cw/2, y = (W.y[i]-view.cy)*view.s + ch/2;
    W.sx[i] = x; W.sy[i] = y;
    const v = x>=-6 && y>=-6 && x<cw+6 && y<ch+6; W.vis[i] = v ? 1 : 0;
    if (!v || !isShown(i)) continue;
    inView++;
    if ((W.grp[i]===0 && on.aband) || (W.grp[i]!==0 && on.done)) put(x|0, y|0, highlightLic>=0 && W.lic[i]!==highlightLic ? col[2] : col[W.grp[i]===0?0:W.grp[i]]);
    const f = W.flags[i];
    if ((on.nom && f&1) || (on.vent && f&4) || (on.mine && mineIdx.has(i))) rings.push(i);
  }
  ctx.putImageData(img, 0, 0);
  const r = Math.max(3, Math.min(8, z/150))*dpr;
  ctx.lineWidth = 1.6*dpr;
  for (const i of rings){ const f = W.flags[i];
    ctx.strokeStyle = on.mine && mineIdx.has(i) ? C.mine : (on.vent && f&4) ? C.vent : C.nom;
    ctx.beginPath(); ctx.arc(W.sx[i], W.sy[i], mineIdx.has(i) && on.mine ? r*1.5 : r, 0, 7); ctx.stroke(); }
  if (selected>=0){ ctx.lineWidth = 2.5*dpr; ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.arc(W.sx[selected], W.sy[selected], r*2, 0, 7); ctx.stroke(); }
  if (me){ const [x,y] = toScreen(...proj(me.lon, me.lat)); ctx.fillStyle = C.me; ctx.strokeStyle = C.panel; ctx.lineWidth = 2.5*dpr; ctx.beginPath(); ctx.arc(x,y,7*dpr,0,7); ctx.fill(); ctx.stroke(); }
  $("status").textContent = `${fmt(inView)} wells in view`;
}

function buildChips(){
  $("chips").innerHTML = LAYERS.map(l => `<label class="chip"><input type="checkbox" id="ly-${l.id}" ${l.on?"checked":""}><span class="sw${l.ring?" ring":""}" style="${l.ring?"border-color":"background"}:var(${l.sw})"></span>${esc(l.label)}</label>`).join("");
  for (const l of LAYERS) $("ly-"+l.id).addEventListener("change", e => { on[l.id] = e.target.checked; draw(); });
}

async function loadAll(){
  const [bin, meta, bm] = await Promise.all([
    fetch("data/wells_b64.txt").then(r => { if (!r.ok) throw new Error("wells "+r.status); return r.text(); }).then(t => { const s = atob(t.trim()); const u = new Uint8Array(s.length); for (let i=0;i<s.length;i++) u[i] = s.charCodeAt(i); return u.buffer; }),
    fetch("data/wells_meta.json").then(r => r.json()), fetch("data/basemap.json").then(r => r.json())]);
  base = bm;
  const dv = new DataView(bin), n = bin.byteLength/13;
  const x = new Float32Array(n), y = new Float32Array(n), lon = new Float32Array(n), lat = new Float32Array(n), grp = new Uint8Array(n), flags = new Uint8Array(n), lic = new Uint16Array(n), fluid = new Uint8Array(n), status = new Uint8Array(n);
  for (let i=0, o=0; i<n; i++, o+=13){
    lon[i] = dv.getFloat32(o,true); lat[i] = dv.getFloat32(o+4,true);
    x[i] = lon[i]*KX; y[i] = -lat[i]; status[i] = dv.getUint8(o+8); flags[i] = dv.getUint8(o+9); lic[i] = dv.getUint16(o+10,true); fluid[i] = dv.getUint8(o+12);
    const s = meta.status[status[i]]; grp[i] = s==="Abandoned"?0 : s==="RecCertified"?1 : s==="RecExempt"?2 : 3;
  }
  W = {n, x, y, lon, lat, grp, flags, lic, fluid, status, meta};
  $("loading").hidden = true;
  idsReady = fetch("data/wells_ids.txt").then(r => r.text()).then(t => { ids = t.split("\n").map(l => l.split(",")); byLic = new Map(ids.map((r,i) => [r[0], i])); markMine(); route(); });
  draw();
}
let byLic = null;
function markMine(){ mineIdx = new Set(); if (!byLic) return; for (const k of mySites.keys()){ const i = byLic.get(k); if (i !== undefined) mineIdx.add(i); } }

/* ---- well facts ---- */
function well(i){
  const idr = ids ? ids[i] : null;
  return { i, licence: idr ? idr[0] : "", surf: idr ? idr[1] : "", licensee: W.meta.licensees[W.lic[i]] || "Unknown",
    fluid: W.meta.fluids[W.fluid[i]] || "Not recorded", statusKey: W.meta.status[W.status[i]] || "Unknown",
    status: STATUS_TXT[W.meta.status[W.status[i]]] || W.meta.status[W.status[i]] || "Unknown",
    lat: W.lat[i], lon: W.lon[i], nominated: !!(W.flags[i]&1), openLeak: !!(W.flags[i]&4), seriousLeak: !!(W.flags[i]&8), vf: W.meta.vf[String(i)] || null };
}
const distKm = (a, b, c, d) => { const R = 6371, t = Math.PI/180, dl = (c-a)*t, dn = (d-b)*t; const h = Math.sin(dl/2)**2 + Math.cos(a*t)*Math.cos(c*t)*Math.sin(dn/2)**2; return 2*R*Math.asin(Math.sqrt(h)); };

function showCard(i){
  selected = i; const card = $("card");
  if (i<0){ card.hidden = true; draw(); return; }
  const w = well(i);
  const rec = mySites.get(w.licence);
  let html = `<button class="x" type="button" aria-label="Close">×</button>
    <h3 class="mono">${esc(w.surf || "…")}</h3><div style="color:var(--muted)">Licence <span class="mono">${esc(w.licence || "…")}</span></div>
    <div class="badges"><span class="badge" style="background:${GROUP_COL[W.grp[i]]}">${esc(w.status)}</span>
    ${w.nominated?'<span class="badge" style="background:var(--nom)">Nominated</span>':""}
    ${w.openLeak?`<span class="badge" style="background:var(--vent)">Open leak${w.seriousLeak?", serious":""}</span>`:""}
    ${rec?'<span class="badge" style="background:var(--mine)">My site</span>':""}</div>
    <dl><dt>Licensee</dt><dd>${esc(w.licensee)}</dd><dt>Fluid</dt><dd>${esc(w.fluid)}</dd>
    <dt>Coordinates</dt><dd class="num">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</dd>
    ${me?`<dt>Distance</dt><dd class="num">${distKm(me.lat,me.lon,w.lat,w.lon).toFixed(1)} km straight line</dd>`:""}
    ${w.vf?`<dt>Leak reports</dt><dd>${w.vf.n} total, ${w.vf.open} unresolved. Latest ${esc(w.vf.date)}: ${esc(w.vf.type)}, ${esc(w.vf.cls.toLowerCase())}</dd>`:""}</dl>
    <button type="button" class="open" id="openSite" ${w.licence?"":"disabled"}>${rec?"Open site record":"Start site record"}</button>`;
  card.innerHTML = html; card.hidden = false;
  card.querySelector(".x").onclick = () => showCard(-1);
  $("openSite").onclick = () => go("site-" + w.licence);
  draw();
}

/* ---- interaction ---- */
const ptrs = new Map(); let moved = false, pinch0 = null;
cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, {x:e.offsetX*dpr, y:e.offsetY*dpr}); moved = false; if (ptrs.size===2){ const [a,b] = [...ptrs.values()]; pinch0 = {d:Math.hypot(a.x-b.x,a.y-b.y), s:view.s}; } });
cv.addEventListener("pointermove", e => { const p = ptrs.get(e.pointerId); if (!p) return; const nx = e.offsetX*dpr, ny = e.offsetY*dpr;
  if (ptrs.size===1){ const dx = nx-p.x, dy = ny-p.y; if (Math.abs(dx)+Math.abs(dy) > 3*dpr){ moved = true; cv.classList.add("dragging"); } view.cx -= dx/view.s; view.cy -= dy/view.s; }
  p.x = nx; p.y = ny;
  if (ptrs.size===2 && pinch0){ const [a,b] = [...ptrs.values()]; zoomAt((a.x+b.x)/2,(a.y+b.y)/2, pinch0.s*Math.hypot(a.x-b.x,a.y-b.y)/pinch0.d/view.s); moved = true; }
  draw(); });
const up = e => { const had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId); if (ptrs.size<2) pinch0 = null; cv.classList.remove("dragging");
  if (had && !moved && e.type==="pointerup" && W){ showCard(pick(e.offsetX*dpr, e.offsetY*dpr)); } };
cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
function pick(px, py){ let best = -1, bd = (14*dpr)**2; for (let i=0;i<W.n;i++){ if (!W.vis[i] || !isShown(i)) continue; const d = (W.sx[i]-px)**2 + (W.sy[i]-py)**2; if (d<bd){ bd = d; best = i; } } return best; }
function zoomAt(px, py, f){ const [wx,wy] = toWorld(px,py); view.s = Math.min(Math.max(view.s*f, 20*dpr), 80000*dpr); view.cx = wx-(px-cw/2)/view.s; view.cy = wy-(py-ch/2)/view.s; draw(); }
cv.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.offsetX*dpr, e.offsetY*dpr, Math.exp(-e.deltaY*0.0018)); }, {passive:false});
cv.addEventListener("dblclick", e => zoomAt(e.offsetX*dpr, e.offsetY*dpr, 2.5));
$("zin").onclick = () => zoomAt(cw/2, ch/2, 1.8);
$("zout").onclick = () => zoomAt(cw/2, ch/2, 1/1.8);
$("zreset").onclick = () => { fitAlberta(); draw(); };
function flyTo(i, scale = 3000){ view.cx = W.x[i]; view.cy = W.y[i]; view.s = Math.max(view.s, scale*dpr); showCard(i); }

/* ---- nearby list ---- */
function listWells(title, note, idxs){
  $("listTitle").textContent = title; $("listNote").innerHTML = note;
  $("wlist").innerHTML = idxs.map(({i, d}) => { const w = well(i);
    return `<li><button type="button" data-i="${i}"><span class="sw${w.openLeak||w.nominated?" ring":""}" style="${w.openLeak||w.nominated?"border-color":"background"}:${w.openLeak?"var(--vent)":w.nominated?"var(--nom)":GROUP_COL[W.grp[i]]}"></span><span class="loc">${esc(w.surf)}</span><span class="dist num">${d!=null?d.toFixed(1)+" km":""}</span><span class="sub">${esc(w.licensee)}${w.openLeak?" · open leak":""}${w.nominated?" · nominated":""}</span></button></li>`; }).join("");
  for (const b of $("wlist").querySelectorAll("button")) b.onclick = () => { flyTo(+b.dataset.i); if (matchMedia("(max-width:760px)").matches) $("mapwrap").scrollIntoView({behavior:"smooth"}); };
}
function nearby(){
  if (!W || !me) return;
  const out = []; for (let i=0;i<W.n;i++){ if (W.grp[i]!==0) continue; const d = distKm(me.lat, me.lon, W.lat[i], W.lon[i]); if (out.length<15 || d<out[out.length-1].d){ out.push({i,d}); out.sort((a,b)=>a.d-b.d); if (out.length>15) out.pop(); } }
  listWells("Nearby wells", `The 15 closest wells awaiting reclamation. Accuracy about ${Math.round(me.acc)} m.`, out);
}
$("locate").onclick = () => {
  if (!("geolocation" in navigator)){ toast("This browser can't share your location."); return; }
  $("locate").disabled = true; $("locate").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(p => {
    me = {lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy};
    $("locate").disabled = false; $("locate").textContent = "Locate me";
    const [x,y] = proj(me.lon, me.lat); view.cx = x; view.cy = y; view.s = Math.max(view.s, 1500*dpr);
    nearby(); draw();
  }, err => {
    $("locate").disabled = false; $("locate").textContent = "Locate me";
    toast(err.code===1 ? "Location is blocked. Allow location for this page in your browser settings." : "Couldn't get a location fix. Try again in the open.");
  }, {enableHighAccuracy:true, timeout:15000, maximumAge:60000});
};

/* ---- search ---- */
$("searchForm").addEventListener("submit", async e => {
  e.preventDefault(); const q = $("q").value.trim(), msg = $("msg"); if (!q || !W) return;
  if (!ids){ msg.textContent = "Loading licence numbers…"; await idsReady; }
  const digits = q.replace(/\D/g,"");
  if (/^[A-Za-z]?\s?\d{1,7}[A-Za-z]?$/.test(q)){
    const up = q.toUpperCase().replace(/\s/g,"");
    let i = byLic.get(up); if (i === undefined) i = byLic.get(digits.padStart(7,"0"));
    if (i === undefined){ msg.textContent = `Licence ${up} isn't in the abandoned-well data. It may still be active or suspended.`; return; }
    msg.textContent = ""; highlightLic = -1; flyTo(i); return;
  }
  const loc = q.toUpperCase().replace(/\s+/g,"");
  if (/^\d{1,2}-\d{1,2}-\d{1,3}-\d{1,2}W\d$/.test(loc)){
    const norm = s => s.split("-").map((p,k) => k===3 ? p.replace(/^(\d+)W/,(m,a)=>a.padStart(2,"0")+"W") : p.padStart(k===2?3:2,"0")).join("-");
    const want = norm(loc); const hits = []; ids.forEach((r,i) => { if (r[1]===want) hits.push(i); });
    if (!hits.length){ msg.textContent = `No abandoned well at ${want}.`; return; }
    msg.textContent = hits.length>1 ? `${hits.length} wells at ${want}.` : ""; highlightLic = -1;
    if (hits.length>1) listWells(`Wells at ${want}`, "More than one licence shares this surface location.", hits.map(i => ({i, d:null})));
    flyTo(hits[0]); return;
  }
  const ql = q.toLowerCase(), L = W.meta.licensees;
  let li = L.findIndex(n => n.toLowerCase()===ql); if (li<0) li = L.findIndex(n => n.toLowerCase().includes(ql));
  if (li<0){ msg.textContent = `No licensee matches “${q}”.`; return; }
  highlightLic = li; showCard(-1);
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,c=0,aw=0; for (let i=0;i<W.n;i++) if (W.lic[i]===li){ c++; if (W.grp[i]===0) aw++; x0=Math.min(x0,W.x[i]); x1=Math.max(x1,W.x[i]); y0=Math.min(y0,W.y[i]); y1=Math.max(y1,W.y[i]); }
  view.cx=(x0+x1)/2; view.cy=(y0+y1)/2; view.s=Math.min(cw/Math.max(x1-x0,0.05), ch/Math.max(y1-y0,0.05))*0.85; view.s = Math.min(view.s, 8000*dpr);
  msg.innerHTML = `${esc(L[li])}: ${fmt(c)} wells, ${fmt(aw)} awaiting reclamation. Others are greyed out. <a href="#" id="clr">Clear</a>`;
  $("clr").onclick = ev => { ev.preventDefault(); highlightLic = -1; msg.textContent = ""; draw(); };
  draw();
});

/* ================= site records ================= */
const nowIso = () => new Date().toISOString();
const when = iso => iso ? new Date(iso).toLocaleString("en-CA", {dateStyle:"medium", timeStyle:"short"}) : "";
function newRecord(w){
  return { licence:w.licence, created:nowIso(), updated:nowIso(),
    well:{surf:w.surf, licensee:w.licensee, fluid:w.fluid, status:w.status, lat:w.lat, lon:w.lon, nominated:w.nominated, openLeak:w.openLeak},
    crew:"", contractor:"", steps:{} };
}
function progress(rec, stageId){
  const stages = stageId ? STAGES.filter(s => s.id===stageId) : STAGES;
  let total = 0, done = 0, issue = 0, na = 0;
  for (const st of stages) for (const sp of st.steps){ total++; const v = rec.steps[st.id+"."+sp.id]?.status; if (v==="done") done++; else if (v==="issue") issue++; else if (v==="na") na++; }
  return {total, done, issue, na, open: total-done-issue-na};
}
let cur = null, curTab = STAGES[0].id, saveT = 0;
function save(){ if (!cur) return; cur.updated = nowIso(); clearTimeout(saveT); saveT = setTimeout(async () => { try { await DB.put(cur); mySites.set(cur.licence, cur); $("siteCount").textContent = mySites.size; markMine(); } catch { toast("Couldn't save on this device. Storage may be full or blocked."); } }, 300); }

async function openSite(lic){
  if (ids === null) await idsReady;
  let rec = null; try { rec = await DB.get(lic); } catch {}
  if (!rec){ const i = byLic.get(lic); if (i === undefined){ toast(`Licence ${lic} isn't in the well data.`); go(""); return; } rec = newRecord(well(i)); }
  cur = rec;
  $("siteTitle").innerHTML = `<b class="mono">${esc(rec.well.surf)}</b><small>Licence ${esc(rec.licence)} · ${esc(rec.well.licensee)}</small>`;
  renderSite();
}
function renderSite(){
  const r = cur, w = r.well;
  const tabs = STAGES.map(s => { const p = progress(r, s.id); return `<button type="button" class="tab" role="tab" aria-selected="${s.id===curTab}" data-t="${s.id}">${esc(s.title)}<span class="tprog num">${p.done+p.na}/${p.total}${p.issue?` · ${p.issue} issue${p.issue>1?"s":""}`:""}</span></button>`; }).join("");
  const st = STAGES.find(s => s.id===curTab);
  $("siteBody").innerHTML = `
    <div class="sitehead">
      <div class="badges"><span class="badge" style="background:var(--s-aband)">${esc(w.status)}</span>${w.nominated?'<span class="badge" style="background:var(--nom)">Nominated</span>':""}${w.openLeak?'<span class="badge" style="background:var(--vent)">Open leak report</span>':""}</div>
      <div class="meta"><div><span>Fluid</span>${esc(w.fluid)}</div><div><span>Coordinates</span><span class="num" style="all:unset">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span></div><div><span>Record started</span>${esc(when(r.created))}</div></div>
      <div class="fields">
        <label>Crew lead<input id="f-crew" value="${esc(r.crew)}" placeholder="Name"></label>
        <label>Contractor<input id="f-contractor" value="${esc(r.contractor)}" placeholder="Company"></label>
      </div>
    </div>
    <div class="tabs" role="tablist">${tabs}</div>
    <div class="stage">
      <p class="purpose">${esc(st.purpose)}</p>
      <span class="draftflag">Draft checklist · for engineering review</span>
      <ol class="steps">${st.steps.map(sp => stepHtml(st, sp)).join("")}</ol>
    </div>`;
  $("f-crew").oninput = e => { cur.crew = e.target.value; save(); };
  $("f-contractor").oninput = e => { cur.contractor = e.target.value; save(); };
  for (const b of document.querySelectorAll(".tab")) b.onclick = () => { curTab = b.dataset.t; renderSite(); };
  wireSteps(st);
}
function stepHtml(st, sp){
  const k = st.id+"."+sp.id, d = cur.steps[k] || {};
  const seg = [["done","Done"],["issue","Issue"],["na","N/A"]].map(([v,t]) => `<button type="button" data-v="${v}" aria-pressed="${d.status===v}">${t}</button>`).join("");
  return `<li class="step" data-k="${k}" data-s="${d.status||""}">
    <div class="stext">${esc(sp.text)}</div>
    <div class="seg" role="group" aria-label="Status">${seg}</div>
    ${sp.reading?`<label class="reading">${esc(sp.reading.label)} <input type="number" inputmode="decimal" step="any" id="r-${k}" value="${esc(d.reading??"")}"> ${esc(sp.reading.unit)}</label>`:""}
    <textarea id="n-${k}" placeholder="Notes" aria-label="Notes for ${esc(sp.text)}">${esc(d.note||"")}</textarea>
    <div class="photos">${(d.photos||[]).map((p,j) => thumbHtml(p, j)).join("")}<label class="addphoto">+ Photo<input type="file" accept="image/*" capture="environment" multiple id="p-${k}"></label></div>
    ${d.at?`<div class="stamp">Last change ${esc(when(d.at))}</div>`:""}
  </li>`;
}
const urls = new Map();
const blobUrl = b => { if (!urls.has(b)) urls.set(b, URL.createObjectURL(b)); return urls.get(b); };
function thumbHtml(p, j){ return `<div class="thumb"><img src="${blobUrl(p.blob)}" alt="Site photo ${j+1}"><button type="button" class="del" data-j="${j}" aria-label="Remove photo">×</button>${p.lat!=null?`<span class="gps">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span>`:""}</div>`; }
function wireSteps(st){
  for (const li of document.querySelectorAll(".step")){
    const k = li.dataset.k; const get = () => (cur.steps[k] ||= {});
    const touch = () => { get().at = nowIso(); save(); };
    for (const b of li.querySelectorAll(".seg button")) b.onclick = () => { const d = get(); d.status = d.status===b.dataset.v ? "" : b.dataset.v; touch(); li.dataset.s = d.status; for (const o of li.querySelectorAll(".seg button")) o.setAttribute("aria-pressed", o.dataset.v===d.status); refreshTabs(); };
    const n = li.querySelector("textarea"); n.oninput = () => { get().note = n.value; touch(); };
    const r = li.querySelector(".reading input"); if (r) r.oninput = () => { get().reading = r.value; touch(); };
    li.querySelector("input[type=file]").onchange = async e => { const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
      toast(files.length>1 ? `Adding ${files.length} photos…` : "Adding photo…");
      const pos = await fix();
      for (const f of files){ try { const blob = await shrink(f); (get().photos ||= []).push({blob, at:nowIso(), lat:pos?.lat ?? null, lon:pos?.lon ?? null, acc:pos?.acc ?? null, name:f.name}); } catch { toast(`Couldn't read ${f.name}.`); } }
      touch(); renderSite();
      toast(pos ? "Photo saved with location." : "Photo saved. No location fix, so it has the time only."); };
    for (const b of li.querySelectorAll(".thumb .del")) b.onclick = () => { get().photos.splice(+b.dataset.j, 1); touch(); renderSite(); };
  }
}
function refreshTabs(){ for (const b of document.querySelectorAll(".tab")){ const p = progress(cur, b.dataset.t); b.querySelector(".tprog").textContent = `${p.done+p.na}/${p.total}${p.issue?` · ${p.issue} issue${p.issue>1?"s":""}`:""}`; } }
function fix(){ return new Promise(res => { if (!("geolocation" in navigator)) return res(me); navigator.geolocation.getCurrentPosition(p => { me = {lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy}; res(me); }, () => res(null), {enableHighAccuracy:true, timeout:8000, maximumAge:30000}); }); }
async function shrink(file){
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const max = 1600, k = Math.min(1, max/Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width*k); c.height = Math.round(bmp.height*k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(b => res(b || file), "image/jpeg", 0.82));
}

/* ---- my sites ---- */
function renderSites(){
  const all = [...mySites.values()].sort((a,b) => b.updated.localeCompare(a.updated));
  if (!all.length){ $("sitesBody").innerHTML = `<div class="empty"><b>No site records yet</b><span>Tap a well on the map, then <b>Start site record</b>. Records are saved on this device.</span><button type="button" id="goMap">Go to the map</button></div>`; $("goMap").onclick = () => go(""); return; }
  $("sitesBody").innerHTML = `<ul class="sites">${all.map(r => { const p = progress(r); const pc = v => (100*v/p.total).toFixed(1)+"%";
    return `<li><button type="button" data-l="${esc(r.licence)}"><div class="top"><b class="mono">${esc(r.well.surf)}</b><span class="note num">${p.done+p.na} of ${p.total} steps${p.issue?`, ${p.issue} issue${p.issue>1?"s":""}`:""}</span></div>
      <div class="bar"><span style="width:${pc(p.done)};background:var(--ok)"></span><span style="width:${pc(p.na)};background:var(--na)"></span><span style="width:${pc(p.issue)};background:var(--bad)"></span></div>
      <div class="note">Licence ${esc(r.licence)} · ${esc(r.well.licensee)} · updated ${esc(when(r.updated))}</div></button></li>`; }).join("")}</ul>
    <div class="tools">${inFrame?"":'<button type="button" class="ghost" id="exportAll">Export backup (JSON)</button>'}</div>
    <p class="note" style="margin-top:10px">Records stay on this device until the sync step is built. ${inFrame?"":"Export a backup before clearing browser data."}</p>`;
  for (const b of $("sitesBody").querySelectorAll(".sites button")) b.onclick = () => go("site-" + b.dataset.l);
  const ex = $("exportAll"); if (ex) ex.onclick = exportAll;
}
async function exportAll(){
  const all = [...mySites.values()];
  const toData = b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
  const out = []; for (const r of all){ const c = structuredClone({...r, steps:{}}); for (const [k,d] of Object.entries(r.steps)){ c.steps[k] = {...d, photos: await Promise.all((d.photos||[]).map(async p => ({...p, blob: await toData(p.blob)})))}; } out.push(c); }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({app:"well-closure-field-app", version:1, exported:nowIso(), sites:out})], {type:"application/json"}));
  a.download = `well-sites-${new Date().toISOString().slice(0,10)}.json`; a.click();
}

/* ---- report ---- */
function renderReport(){
  const r = cur, w = r.well, p = progress(r);
  const label = {done:"Done", issue:"Issue", na:"N/A"};
  $("reportBody").innerHTML = `<div>
    <h1 class="mono">${esc(w.surf)}</h1>
    <p class="note">Well Closure Field App site report · generated ${esc(when(nowIso()))}</p>
    <div class="meta" style="margin-top:12px">
      <div><span>Licence</span>${esc(r.licence)}</div><div><span>Licensee</span>${esc(w.licensee)}</div><div><span>Licence status (Jan 2025)</span>${esc(w.status)}</div>
      <div><span>Coordinates</span>${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div><div><span>Crew lead</span>${esc(r.crew||"Not recorded")}</div><div><span>Contractor</span>${esc(r.contractor||"Not recorded")}</div>
      <div><span>Progress</span>${p.done+p.na} of ${p.total} steps, ${p.issue} issue${p.issue===1?"":"s"}</div><div><span>Last updated</span>${esc(when(r.updated))}</div>
    </div>
    ${STAGES.map(st => `<h2>${esc(st.title)}</h2><div class="tw"><table><thead><tr><th>Step</th><th>Status</th><th>Reading</th><th>Notes and photos</th></tr></thead><tbody>
      ${st.steps.map(sp => { const d = r.steps[st.id+"."+sp.id] || {};
        return `<tr><td>${esc(sp.text)}</td><td class="${d.status?"st-"+d.status:""}">${esc(label[d.status]||"Open")}</td><td class="num">${d.reading?esc(d.reading+" "+sp.reading.unit):""}</td>
        <td>${esc(d.note||"")}${(d.photos||[]).length?`<div class="rphotos">${d.photos.map((ph,j) => `<img src="${blobUrl(ph.blob)}" alt="Photo ${j+1}">`).join("")}</div><div class="note">${d.photos.map(ph => `${when(ph.at)}${ph.lat!=null?` at ${ph.lat.toFixed(5)}, ${ph.lon.toFixed(5)}`:""}`).map(esc).join("; ")}</div>`:""}</td></tr>`; }).join("")}
      </tbody></table></div>`).join("")}
    <p class="note" style="margin-top:20px">Checklist steps are a draft for engineering review and are not yet a statement of AER requirements.</p></div>`;
}

/* ================= routing ================= */
function go(h){ if (location.hash.slice(1) === h) route(); else location.hash = h; }
function show(id){ for (const v of ["siteView","sitesView","reportView"]) $(v).hidden = v !== id; }
async function route(){
  const h = location.hash.slice(1);
  if (h.startsWith("site-")){ show("siteView"); const lic = h.slice(5); if (!cur || cur.licence !== lic) await openSite(lic); else renderSite(); }
  else if (h.startsWith("report-")){ const lic = h.slice(7); if (!cur || cur.licence !== lic) await openSite(lic); show("reportView"); renderReport(); }
  else if (h === "sites"){ show("sitesView"); renderSites(); }
  else { show(""); if (W){ requestAnimationFrame(resize); if (cur && byLic){ const i = byLic.get(cur.licence); if (i !== undefined) showCard(i); } } }
}
addEventListener("hashchange", route);
$("openSites").onclick = () => go("sites");
$("backFromSite").onclick = () => go("");
$("backFromSites").onclick = () => go("");
$("toReport").onclick = () => go("report-" + cur.licence);
$("backFromReport").onclick = () => go("site-" + cur.licence);
if (inFrame) $("printReport").hidden = true; else $("printReport").onclick = () => window.print();

/* ================= start ================= */
const retheme = () => { C = css(); draw(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
new MutationObserver(retheme).observe(document.documentElement, {attributes:true, attributeFilter:["data-theme"]});
new ResizeObserver(() => { const had = cw; resize(); if (!had) fitAlberta(); draw(); }).observe($("mapwrap"));
buildChips();
refreshSites();
loadAll().catch(err => { $("loading").textContent = "The well data didn't load. Check your connection and reload."; console.error(err); });
if ("serviceWorker" in navigator && !inFrame && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
