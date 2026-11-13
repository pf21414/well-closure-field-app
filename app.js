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
/* v1: "sites" keyed by licence. v2 adds "packages" keyed by id. */
const store = name => (() => {
  const tx = async (mode, fn) => { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(name, mode); const out = fn(t.objectStore(name)); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx("readonly", s => s.get(k)),
    all: () => tx("readonly", s => s.getAll()),
    put: rec => tx("readwrite", s => { s.put(rec); }),
    del: k => tx("readwrite", s => { s.delete(k); }),
  };
})();
let dbp = null;
const openDB = () => dbp ||= new Promise((res, rej) => {
  try {
    const r = indexedDB.open("well-field-app", 2);
    r.onupgradeneeded = () => { const db = r.result;
      if (!db.objectStoreNames.contains("sites")) db.createObjectStore("sites", {keyPath:"licence"});
      if (!db.objectStoreNames.contains("packages")) db.createObjectStore("packages", {keyPath:"id"}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  } catch (e) { rej(e); }
});
const DB = store("sites"), PK = store("packages");
let pkgs = new Map(); // id -> package
async function refreshPackages(){
  try { pkgs = new Map((await PK.all()).map(p => [p.id, p])); } catch { pkgs = new Map(); }
  $("pkgCount").textContent = pkgs.size;
  if (activePkg && !pkgs.has(activePkg)) setActivePkg(null);
  draw();
}
async function savePkg(p){ p.updated = new Date().toISOString(); try { await PK.put(p); pkgs.set(p.id, p); $("pkgCount").textContent = pkgs.size; } catch { toast("Couldn't save the package on this device."); } }
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
  aband:g("--s-aband"), cert:g("--s-cert"), exempt:g("--s-exempt"), other:g("--s-other"), nom:g("--nom"), vent:g("--vent"), mine:g("--mine"), me:g("--me"), pkg:g("--pkg") }; };
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
let activePkg = null, pkgIdx = []; // indices of the active package's wells, in visit order
let selMode = false, selRect = null; // area selection in screen px
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
  if (pkgIdx.length){
    ctx.setLineDash([5*dpr, 4*dpr]); ctx.lineWidth = 1.4*dpr; ctx.strokeStyle = C.pkg; ctx.beginPath();
    pkgIdx.forEach((i,k) => { const [x,y] = toScreen(W.x[i], W.y[i]); k ? ctx.lineTo(x,y) : ctx.moveTo(x,y); }); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.pkg; ctx.strokeStyle = C.panel; ctx.lineWidth = 1.5*dpr;
    const pr = Math.max(4, Math.min(9, z/120))*dpr;
    for (const i of pkgIdx){ const [x,y] = toScreen(W.x[i], W.y[i]); if (x<-10||y<-10||x>cw+10||y>ch+10) continue; ctx.beginPath(); ctx.moveTo(x,y-pr); ctx.lineTo(x+pr,y); ctx.lineTo(x,y+pr); ctx.lineTo(x-pr,y); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  }
  if (selRect){ const {x0,y0,x1,y1} = selRect; ctx.fillStyle = C.pkg + "22"; ctx.strokeStyle = C.pkg; ctx.lineWidth = 2*dpr; ctx.setLineDash([6*dpr,4*dpr]);
    ctx.fillRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0)); ctx.strokeRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0)); ctx.setLineDash([]); }
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
  idsReady = fetch("data/wells_ids.txt").then(r => r.text()).then(t => { ids = t.split("\n").map(l => l.split(",")); byLic = new Map(ids.map((r,i) => [r[0], i])); markMine(); if (activePkg) setActivePkg(activePkg); route(); });
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
    <button type="button" class="open" id="openSite" ${w.licence?"":"disabled"}>${rec?"Open site record":"Start site record"}</button>
    ${inPkgs(w.licence).length?`<p class="note" style="margin-top:8px">In package: ${inPkgs(w.licence).map(p => esc(p.name)).join(", ")}</p>`:""}
    <button type="button" class="ghost add" id="addToPkg" ${w.licence?"":"disabled"}>Add to a work package</button>`;
  card.innerHTML = html; card.hidden = false;
  card.querySelector(".x").onclick = () => showCard(-1);
  $("openSite").onclick = () => go("site-" + w.licence);
  $("addToPkg").onclick = () => openSheet([i], "this well");
  draw();
}

/* ---- interaction ---- */
const ptrs = new Map(); let moved = false, pinch0 = null;
cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId);
  if (selMode){ const x = e.offsetX*dpr, y = e.offsetY*dpr; selRect = {x0:x, y0:y, x1:x, y1:y, id:e.pointerId}; draw(); return; }
  ptrs.set(e.pointerId, {x:e.offsetX*dpr, y:e.offsetY*dpr}); moved = false; if (ptrs.size===2){ const [a,b] = [...ptrs.values()]; pinch0 = {d:Math.hypot(a.x-b.x,a.y-b.y), s:view.s}; } });
cv.addEventListener("pointermove", e => {
  if (selRect && selRect.id===e.pointerId){ selRect.x1 = e.offsetX*dpr; selRect.y1 = e.offsetY*dpr; draw(); return; }
  const p = ptrs.get(e.pointerId); if (!p) return; const nx = e.offsetX*dpr, ny = e.offsetY*dpr;
  if (ptrs.size===1){ const dx = nx-p.x, dy = ny-p.y; if (Math.abs(dx)+Math.abs(dy) > 3*dpr){ moved = true; cv.classList.add("dragging"); } view.cx -= dx/view.s; view.cy -= dy/view.s; }
  p.x = nx; p.y = ny;
  if (ptrs.size===2 && pinch0){ const [a,b] = [...ptrs.values()]; zoomAt((a.x+b.x)/2,(a.y+b.y)/2, pinch0.s*Math.hypot(a.x-b.x,a.y-b.y)/pinch0.d/view.s); moved = true; }
  draw(); });
const up = e => {
  if (selRect && selRect.id===e.pointerId){ const r = selRect; selRect = null; draw(); if (e.type==="pointerup") finishSelect(r); return; }
  const had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId); if (ptrs.size<2) pinch0 = null; cv.classList.remove("dragging");
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
      ${landHtml(r)}
      ${inPkgs(r.licence).length?`<p class="note">In package: ${inPkgs(r.licence).map(p => `<a href="#pkg-${esc(p.id)}">${esc(p.name)}</a>`).join(", ")}</p>`:""}
    </div>
    <div class="tabs" role="tablist">${tabs}</div>
    <div class="stage">
      <p class="purpose">${esc(st.purpose)}</p>
      <span class="draftflag">Draft checklist · for engineering review</span>
      <ol class="steps">${st.steps.map(sp => stepHtml(st, sp)).join("")}</ol>
    </div>`;
  $("f-crew").oninput = e => { cur.crew = e.target.value; save(); };
  $("f-contractor").oninput = e => { cur.contractor = e.target.value; save(); };
  wireLand();
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


/* ---- landowner, title and access ---- */
const LAND = [
  {k:"owner", label:"Landowner or occupant", ph:"Name"},
  {k:"phone", label:"Phone", ph:"403-555-0100", type:"tel"},
  {k:"email", label:"Email", ph:"name@example.com", type:"email"},
  {k:"address", label:"Mailing address", ph:"Box, town, postal code", wide:true},
  {k:"titleNo", label:"Land title number", ph:"e.g. 192 345 678"},
  {k:"linc", label:"LINC", ph:"e.g. 0012 345 678"},
  {k:"lease", label:"Surface lease or disposition", ph:"Lease or agreement number"},
  {k:"accessDate", label:"Access confirmed on", type:"date"},
  {k:"access", label:"Access notes", ph:"Gates, locks, livestock, road conditions, who to call first", area:true, wide:true},
];
function landHtml(r){
  const L = r.land || {};
  const sum = L.owner ? `${esc(L.owner)}${L.accessDate?` · access ${esc(fmtDate(L.accessDate))}`:" · access not confirmed"}` : "Not recorded";
  return `<details class="land" id="landBox"><summary>Landowner and access<small>${sum}</small></summary>
    <div class="fields">
      <label class="wide" style="font-size:.8rem;color:var(--muted)">Legal land location<span class="mono" style="color:var(--ink);font-size:.95rem">${esc(r.well.surf)}</span></label>
      ${LAND.map(f => f.area ? `<label class="wide">${f.label}<textarea id="l-${f.k}" placeholder="${esc(f.ph)}">${esc(L[f.k]||"")}</textarea></label>`
        : f.type==="tel" ? `<label>${f.label}<span class="callrow"><input type="tel" id="l-${f.k}" value="${esc(L[f.k]||"")}" placeholder="${esc(f.ph)}">${L.phone?`<a href="tel:${esc(L.phone.replace(/[^\d+]/g,""))}">Call</a>`:""}</span></label>`
        : `<label class="${f.wide?"wide":""}">${f.label}<input ${f.type?`type="${f.type}"`:""} id="l-${f.k}" value="${esc(L[f.k]||"")}" ${f.ph?`placeholder="${esc(f.ph)}"`:""}></label>`).join("")}
      <p class="note wide">Title details come from an Alberta Land Titles (SPIN 2) search on the legal land location. Saved on this phone only, and included when a package is sent.</p>
    </div></details>`;
}
let landOpen = false;
function wireLand(){
  const box = $("landBox"); box.open = landOpen; box.ontoggle = () => { landOpen = box.open; };
  for (const f of LAND){ const el = $("l-" + f.k); el.oninput = () => { (cur.land ||= {})[f.k] = el.value; save(); }; }
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
    <h2>Landowner and access</h2>
    ${r.land && Object.values(r.land).some(Boolean) ? `<div class="meta">${LAND.filter(f => r.land[f.k]).map(f => `<div${f.wide?' style="grid-column:1 / -1"':""}><span>${f.label}</span>${esc(f.type==="date" ? fmtDate(r.land[f.k]) : r.land[f.k])}</div>`).join("")}</div>` : `<p class="note">Not recorded.</p>`}
    ${STAGES.map(st => `<h2>${esc(st.title)}</h2><div class="tw"><table><thead><tr><th>Step</th><th>Status</th><th>Reading</th><th>Notes and photos</th></tr></thead><tbody>
      ${st.steps.map(sp => { const d = r.steps[st.id+"."+sp.id] || {};
        return `<tr><td>${esc(sp.text)}</td><td class="${d.status?"st-"+d.status:""}">${esc(label[d.status]||"Open")}</td><td class="num">${d.reading?esc(d.reading+" "+sp.reading.unit):""}</td>
        <td>${esc(d.note||"")}${(d.photos||[]).length?`<div class="rphotos">${d.photos.map((ph,j) => `<img src="${blobUrl(ph.blob)}" alt="Photo ${j+1}">`).join("")}</div><div class="note">${d.photos.map(ph => `${when(ph.at)}${ph.lat!=null?` at ${ph.lat.toFixed(5)}, ${ph.lon.toFixed(5)}`:""}`).map(esc).join("; ")}</div>`:""}</td></tr>`; }).join("")}
      </tbody></table></div>`).join("")}
    <p class="note" style="margin-top:20px">Checklist steps are a draft for engineering review and are not yet a statement of AER requirements.</p></div>`;
}


/* ================= work packages ================= */
const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const inPkgs = lic => [...pkgs.values()].filter(p => p.wells.includes(lic));
const idxOf = lic => byLic ? byLic.get(lic) : undefined;

$("selArea").onclick = () => setSelMode(!selMode);
function setSelMode(v){ selMode = v; $("selArea").setAttribute("aria-pressed", v); $("selHint").hidden = !v; cv.classList.toggle("selecting", v); if (v){ showCard(-1); closeSheet(); } }
addEventListener("keydown", e => { if (e.key==="Escape"){ if (selMode) setSelMode(false); closeSheet(); } });

function finishSelect(r){
  setSelMode(false);
  if (!W || !ids) { toast("Well data is still loading."); return; }
  const x0 = Math.min(r.x0,r.x1), x1 = Math.max(r.x0,r.x1), y0 = Math.min(r.y0,r.y1), y1 = Math.max(r.y0,r.y1);
  if (x1-x0 < 8*dpr || y1-y0 < 8*dpr){ toast("Drag a larger box to select wells."); return; }
  const all = [], awaiting = [];
  for (let i=0;i<W.n;i++){ const x = W.sx[i], y = W.sy[i]; if (x<x0||x>x1||y<y0||y>y1) continue; if (!isShown(i)) continue; all.push(i); if (W.grp[i]===0) awaiting.push(i); }
  if (!all.length){ toast("No wells shown in that box. Turn on more map layers or draw a bigger box."); return; }
  openSheet(all, null, awaiting);
}

let sheetSel = null;
function openSheet(all, label, awaiting){
  sheetSel = {all, awaiting: awaiting || all};
  const nom = all.filter(i => W.flags[i]&1).length, leak = all.filter(i => W.flags[i]&4).length;
  const opts = [...pkgs.values()].sort((a,b) => b.updated.localeCompare(a.updated)).map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.wells.length} wells)</option>`).join("");
  const showFilter = !label && awaiting && awaiting.length !== all.length;
  $("sheet").innerHTML = `
    <div><b>${label ? "Add " + esc(label) : `${fmt(all.length)} well${all.length>1?"s":""} selected`}</b>${!label?`<div class="note">${fmt(awaiting.length)} awaiting reclamation${nom?`, ${fmt(nom)} nominated`:""}${leak?`, ${fmt(leak)} with an open leak report`:""}</div>`:""}</div>
    ${showFilter?`<label class="inl"><input type="checkbox" id="onlyAwait" checked> Only wells awaiting reclamation</label>`:""}
    <div class="row"><select id="sheetPkg" aria-label="Package">${opts}<option value="__new">New package…</option></select></div>
    <div class="row" id="newRow" ${opts?"hidden":""}><input type="text" id="newName" placeholder="Package name, e.g. Provost north, spring 2027" aria-label="New package name"></div>
    ${(!label && all.length > 400)?`<p class="note">That's a lot of wells for one crew. Zoom in for a smaller package if you can.</p>`:""}
    <div class="row"><button type="button" class="ghost" id="sheetCancel">Cancel</button><button type="button" id="sheetAdd">Add to package</button></div>`;
  $("sheet").hidden = false;
  const sel = $("sheetPkg"); if (!opts) sel.value = "__new";
  sel.onchange = () => { $("newRow").hidden = sel.value !== "__new"; if (sel.value==="__new") $("newName").focus(); };
  $("sheetCancel").onclick = closeSheet;
  $("sheetAdd").onclick = async () => {
    const list = ($("onlyAwait") && $("onlyAwait").checked) ? sheetSel.awaiting : sheetSel.all;
    if (!list.length){ toast("None of the selected wells are awaiting reclamation."); return; }
    let p;
    if (sel.value === "__new"){ const name = $("newName").value.trim(); if (!name){ $("newName").focus(); toast("Give the package a name."); return; }
      p = {id:newId(), name, crew:"", contractor:"", start:"", target:"", notes:"", wells:[], created:new Date().toISOString(), updated:""}; }
    else p = pkgs.get(sel.value);
    const before = p.wells.length; const set = new Set(p.wells);
    for (const i of list){ const lic = ids[i][0]; if (lic && !set.has(lic)){ set.add(lic); p.wells.push(lic); } }
    p.wells = routeOrder(p.wells);
    await savePkg(p); closeSheet(); setActivePkg(p.id);
    const added = p.wells.length - before;
    toast(added ? `Added ${added} well${added>1?"s":""} to ${p.name}.` : `Those wells were already in ${p.name}.`);
  };
}
function closeSheet(){ $("sheet").hidden = true; sheetSel = null; }

/* Suggested visit order: nearest neighbour, starting from the south-west-most well. */
function routeOrder(lics){
  if (!byLic || lics.length < 3) return lics.slice();
  const pts = lics.map(l => { const i = byLic.get(l); return i===undefined ? null : {l, lat:W.lat[i], lon:W.lon[i]}; });
  const known = pts.filter(Boolean), unknown = lics.filter((l,k) => !pts[k]);
  let cur = known.reduce((a,b) => (b.lat + b.lon*0.6 < a.lat + a.lon*0.6 ? b : a));
  const out = [cur], left = new Set(known); left.delete(cur);
  while (left.size){ let best = null, bd = Infinity; for (const q of left){ const d = (q.lat-cur.lat)**2 + ((q.lon-cur.lon)*0.58)**2; if (d<bd){ bd=d; best=q; } } out.push(best); left.delete(best); cur = best; }
  return out.map(p => p.l).concat(unknown);
}
function routeKm(p){ let km = 0, prev = null; for (const l of p.wells){ const i = idxOf(l); if (i===undefined) continue; if (prev!==null) km += distKm(W.lat[prev], W.lon[prev], W.lat[i], W.lon[i]); prev = i; } return km; }

function setActivePkg(id){
  activePkg = id && pkgs.has(id) ? id : null;
  const p = activePkg && pkgs.get(activePkg);
  pkgIdx = p && byLic ? p.wells.map(idxOf).filter(i => i!==undefined) : [];
  const bar = $("pkgbar");
  if (p){ bar.innerHTML = `<span class="sw" style="background:var(--pkg);transform:rotate(45deg)"></span><b>${esc(p.name)}</b><span class="num">${p.wells.length} wells</span><button type="button" class="ghost" id="pkgOpen">Open</button><button type="button" class="ghost" id="pkgHide" aria-label="Stop showing this package">×</button>`;
    bar.hidden = false; $("pkgOpen").onclick = () => go("pkg-" + p.id); $("pkgHide").onclick = () => setActivePkg(null); }
  else bar.hidden = true;
  draw();
}
function fitTo(idxs){ if (!idxs.length) return; let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9; for (const i of idxs){ x0=Math.min(x0,W.x[i]); x1=Math.max(x1,W.x[i]); y0=Math.min(y0,W.y[i]); y1=Math.max(y1,W.y[i]); }
  view.cx=(x0+x1)/2; view.cy=(y0+y1)/2; view.s=Math.min(cw/Math.max(x1-x0,0.02), ch/Math.max(y1-y0,0.02))*0.8; view.s = Math.min(view.s, 12000*dpr); draw(); }

function siteProgress(lic){ const r = mySites.get(lic); return r ? progress(r) : null; }
function pkgProgress(p){ let total = 0, done = 0, issue = 0, started = 0, access = 0, owner = 0;
  const per = STAGES.reduce((n,st) => n + st.steps.length, 0);
  for (const l of p.wells){ const r = mySites.get(l); total += per; if (!r) continue; started++; const g = progress(r); done += g.done + g.na; issue += g.issue; if (r.land?.accessDate) access++; if (r.land?.owner) owner++; }
  return {total, done, issue, started, access, owner, wells:p.wells.length}; }

/* ---- packages list ---- */
function renderPkgs(){
  const all = [...pkgs.values()].sort((a,b) => b.updated.localeCompare(a.updated));
  const tools = `<div class="tools"><button type="button" id="pkgNew">New package</button><button type="button" class="ghost" id="pkgImport">Import package file</button></div>`;
  if (!all.length){ $("pkgsBody").innerHTML = `<div class="empty"><b>No work packages yet</b><span>On the map, tap the box button and drag around a group of wells. Or open any well and tap <b>Add to a work package</b>.</span><button type="button" id="goMap2">Go to the map</button></div>${tools}`; $("goMap2").onclick = () => { go(""); setTimeout(() => setSelMode(true), 50); }; }
  else $("pkgsBody").innerHTML = `<ul class="pkgs">${all.map(p => { const g = pkgProgress(p); const pc = v => g.total ? (100*v/g.total).toFixed(1)+"%" : "0%";
    return `<li><button type="button" data-p="${esc(p.id)}"><div class="top"><b>${esc(p.name)}</b><span class="note num">${g.wells} wells · ${g.started} started${g.issue?` · ${g.issue} issue${g.issue>1?"s":""}`:""}</span></div>
      <div class="bar"><span style="width:${pc(g.done)};background:var(--ok)"></span><span style="width:${pc(g.issue)};background:var(--bad)"></span></div>
      <div class="note">${p.crew?`Crew lead ${esc(p.crew)}`:"No crew assigned"}${p.target?` · target ${esc(fmtDate(p.target))}`:""}</div></button></li>`; }).join("")}</ul>${tools}`;
  for (const b of $("pkgsBody").querySelectorAll(".pkgs button")) b.onclick = () => go("pkg-" + b.dataset.p);
  $("pkgNew").onclick = async () => { const p = {id:newId(), name:"New package", crew:"", contractor:"", start:"", target:"", notes:"", wells:[], created:new Date().toISOString(), updated:""}; await savePkg(p); go("pkg-" + p.id); };
  $("pkgImport").onclick = () => $("importFile").click();
}
const fmtDate = d => { if (!d) return ""; const t = new Date(d + "T12:00:00"); return isNaN(t) ? d : t.toLocaleDateString("en-CA", {dateStyle:"medium"}); };

/* ---- package detail ---- */
let curPkg = null;
async function renderPkg(id){
  const p = pkgs.get(id); if (!p){ toast("That package isn't on this device."); go("packages"); return; }
  curPkg = p; if (ids === null) await idsReady;
  $("pkgTitle").innerHTML = `<b>${esc(p.name)}</b><small>${p.wells.length} wells${p.crew?` · ${esc(p.crew)}`:""}</small>`;
  const g = pkgProgress(p), km = routeKm(p);
  $("pkgBody").innerHTML = `<div>
    <div class="pfields">
      <label class="wide">Package name<input id="p-name" value="${esc(p.name)}"></label>
      <label>Crew lead<input id="p-crew" value="${esc(p.crew)}" placeholder="Name"></label>
      <label>Contractor<input id="p-contractor" value="${esc(p.contractor)}" placeholder="Company"></label>
      <label>Start date<input type="date" id="p-start" value="${esc(p.start)}"></label>
      <label>Target finish<input type="date" id="p-target" value="${esc(p.target)}"></label>
      <label class="wide">Notes<textarea id="p-notes" placeholder="Scope, client, access instructions">${esc(p.notes)}</textarea></label>
    </div>
    <div class="offline" id="offline"><span class="dot"></span><span id="offlineTxt">Checking whether this phone is ready to work offline…</span></div>
    <div class="pstats">
      <div><b>${g.wells}</b><span>wells</span></div>
      <div><b>${g.started}</b><span>site records started</span></div>
      <div><b>${g.total?Math.round(100*g.done/g.total):0}%</b><span>checklist steps done</span></div>
      <div><b>${g.issue}</b><span>open issues</span></div>
      <div><b>${g.access}</b><span>access confirmed</span></div>
    </div>
    <div class="tools" style="margin:0 auto 14px">
      <button type="button" id="p-map" ${p.wells.length?"":"disabled"}>Show on map</button>
      <button type="button" class="ghost" id="p-add">Add wells</button>
      ${inFrame?"":`<button type="button" class="ghost" id="p-send" ${p.wells.length?"":"disabled"}>Send to a crew phone</button>`}
      <button type="button" class="danger" id="p-del">Delete package</button>
    </div>
    <h2>Suggested visit order${km?` · about ${fmt(Math.round(km))} km between sites, straight line`:""}</h2>
    ${p.wells.length ? `<ol class="pwells">${p.wells.map((l,k) => pwellHtml(l,k)).join("")}</ol>` : `<p class="note">No wells yet. Tap <b>Add wells</b>, then drag a box on the map.</p>`}
  </div>`;
  const bind = (id, key) => { $(id).oninput = e => { p[key] = e.target.value; clearTimeout(bind.t); bind.t = setTimeout(() => { savePkg(p); if (key==="name"||key==="crew") $("pkgTitle").innerHTML = `<b>${esc(p.name)}</b><small>${p.wells.length} wells${p.crew?` · ${esc(p.crew)}`:""}</small>`; if (activePkg===p.id) setActivePkg(p.id); }, 300); }; };
  bind("p-name","name"); bind("p-crew","crew"); bind("p-contractor","contractor"); bind("p-start","start"); bind("p-target","target"); bind("p-notes","notes");
  $("p-map").onclick = () => { setActivePkg(p.id); go(""); requestAnimationFrame(() => requestAnimationFrame(() => fitTo(pkgIdx))); };
  $("p-add").onclick = () => { setActivePkg(p.id); go(""); setTimeout(() => { if (pkgIdx.length) fitTo(pkgIdx); setSelMode(true); }, 60); };
  const send = $("p-send"); if (send) send.onclick = () => exportPkg(p);
  const del = $("p-del"); del.onclick = async () => {
    if (!del.classList.contains("armed")){ del.classList.add("armed"); del.textContent = "Tap again to delete"; setTimeout(() => { del.classList.remove("armed"); del.textContent = "Delete package"; }, 4000); return; }
    try { await PK.del(p.id); } catch {} pkgs.delete(p.id); $("pkgCount").textContent = pkgs.size; if (activePkg===p.id) setActivePkg(null);
    toast(`Deleted ${p.name}. Its site records are kept.`); go("packages"); };
  for (const li of $("pkgBody").querySelectorAll(".pwells li")){
    const l = li.dataset.l;
    li.querySelector(".op").onclick = () => go("site-" + l);
    li.querySelector(".rm").onclick = async () => { p.wells = p.wells.filter(x => x !== l); await savePkg(p); if (activePkg===p.id) setActivePkg(p.id); renderPkg(p.id); toast("Removed from the package."); };
  }
  checkOffline();
}
function pwellHtml(l, k){
  const i = idxOf(l), w = i!==undefined ? well(i) : null, r = mySites.get(l), g = r ? progress(r) : null;
  const pc = v => (100*v/g.total).toFixed(1)+"%";
  return `<li data-l="${esc(l)}"><span class="n">${k+1}</span><div class="w">
    <div><b class="mono">${esc(w ? w.surf : l)}</b> <span class="note">Licence ${esc(l)}</span></div>
    <div class="tags">${w && w.nominated?'<span class="tag" style="background:var(--nom)">Nominated</span>':""}${w && w.openLeak?'<span class="tag" style="background:var(--vent)">Open leak</span>':""}${r?.land?.accessDate?'<span class="tag" style="background:var(--ok)">Access confirmed</span>':""}</div>
    ${g?`<div class="bar"><span style="width:${pc(g.done)};background:var(--ok)"></span><span style="width:${pc(g.na)};background:var(--na)"></span><span style="width:${pc(g.issue)};background:var(--bad)"></span></div>`:""}
    <div class="note">${esc(w ? w.licensee : "Not in the well data")}${g?` · ${g.done+g.na}/${g.total} steps${g.issue?`, ${g.issue} issue${g.issue>1?"s":""}`:""}`:" · not started"}${r?.land?.owner?` · ${esc(r.land.owner)}`:""}</div></div>
    <div class="acts"><button type="button" class="op">${r?"Open":"Start"}</button><button type="button" class="ghost rm" aria-label="Remove from package">×</button></div></li>`;
}

/* ---- offline readiness ---- */
const OFFLINE_FILES = ["index.html","app.css","app.js","checklists.js","data/wells_b64.txt","data/wells_ids.txt","data/wells_meta.json","data/basemap.json"];
async function checkOffline(){
  const box = $("offline"); if (!box) return; const txt = $("offlineTxt");
  if (inFrame || !("caches" in window) || !("serviceWorker" in navigator) || location.protocol==="file:"){ box.dataset.ok = "0"; txt.textContent = "Offline mode works in the installed app at its web address, not in this preview."; return; }
  try {
    const miss = []; for (const f of OFFLINE_FILES){ if (!(await caches.match(new URL(f, location.href).href, {ignoreSearch:true}))) miss.push(f); }
    if (!miss.length){ box.dataset.ok = "1"; txt.innerHTML = "<b>Ready offline.</b> The app, the map and all well data are saved on this phone. Site records are always saved here."; return; }
    box.dataset.ok = "0"; txt.innerHTML = "<b>Not ready offline yet.</b> Save the map and well data to this phone while you have signal.";
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Save for offline"; box.appendChild(b);
    b.onclick = async () => { b.disabled = true; b.textContent = "Saving…";
      try { await navigator.serviceWorker.ready; for (const f of OFFLINE_FILES) await fetch(f, {cache:"reload"}); b.remove(); setTimeout(checkOffline, 600); }
      catch { b.disabled = false; b.textContent = "Save for offline"; toast("Couldn't download the data. Check your signal and try again."); } };
  } catch { box.dataset.ok = "0"; txt.textContent = "Couldn't check offline storage on this browser."; }
}

/* ---- send and receive package files ---- */
const blobToData = b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
const dataToBlob = async d => (await fetch(d)).blob();
async function exportPkg(p){
  toast("Preparing the package file…");
  const sites = [];
  for (const l of p.wells){ const r = mySites.get(l); if (!r) continue; const c = {...r, steps:{}};
    for (const [k,d] of Object.entries(r.steps)) c.steps[k] = {...d, photos: await Promise.all((d.photos||[]).map(async ph => ({...ph, blob: await blobToData(ph.blob)})))};
    sites.push(c); }
  const name = `${p.name.replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-") || "package"}-${new Date().toISOString().slice(0,10)}.json`;
  const file = new File([JSON.stringify({app:"well-closure-field-app", kind:"package", version:2, exported:new Date().toISOString(), package:p, sites})], name, {type:"application/json"});
  try { if (navigator.canShare && navigator.canShare({files:[file]})){ await navigator.share({files:[file], title:p.name, text:`Work package: ${p.name}. Open the Well Closure Field App, go to Packages and tap Import package file.`}); return; } }
  catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast("Package file saved. Send it to the crew by email or text.");
}
$("importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  let j; try { j = JSON.parse(await f.text()); } catch { toast("That file isn't a package file from this app."); return; }
  if (j.app !== "well-closure-field-app" || !j.package){ toast("That file isn't a package file from this app."); return; }
  const p = j.package, had = pkgs.get(p.id);
  if (had){ const set = new Set(had.wells); for (const l of p.wells) if (!set.has(l)) had.wells.push(l); for (const k of ["name","crew","contractor","start","target","notes"]) if (p[k] && (!had[k] || p.updated > had.updated)) had[k] = p[k]; await savePkg(had); }
  else await savePkg(p);
  let newer = 0, kept = 0;
  for (const s of j.sites || []){
    let local = null; try { local = await DB.get(s.licence); } catch {}
    if (local && local.updated >= s.updated){ kept++; continue; }
    for (const d of Object.values(s.steps)) for (const ph of d.photos || []) ph.blob = await dataToBlob(ph.blob);
    try { await DB.put(s); newer++; } catch {}
  }
  await refreshSites(); await refreshPackages();
  toast(`Imported ${p.name}: ${p.wells.length} wells${newer?`, ${newer} site record${newer>1?"s":""} updated`:""}${kept?`, ${kept} kept because this phone's copy is newer`:""}.`);
  go("pkg-" + p.id);
};

/* ---- package report ---- */
function renderPkgReport(){
  const p = curPkg, g = pkgProgress(p), km = routeKm(p);
  const label = {done:"Done", issue:"Issue", na:"N/A"};
  const issues = [];
  const rows = p.wells.map((l,k) => { const i = idxOf(l), w = i!==undefined ? well(i) : null, r = mySites.get(l);
    const cells = STAGES.map(st => { if (!r) return `<td class="num">–</td>`; const s = progress(r, st.id); return `<td class="num">${s.done+s.na}/${s.total}${s.issue?` <span class="st-issue">(${s.issue})</span>`:""}</td>`; }).join("");
    if (r) for (const st of STAGES) for (const sp of st.steps){ const d = r.steps[st.id+"."+sp.id]; if (d?.status==="issue") issues.push({surf: w ? w.surf : l, stage: st.title, step: sp.text, note: d.note || "", reading: d.reading ? d.reading + " " + (sp.reading?.unit||"") : ""}); }
    return `<tr><td class="num">${k+1}</td><td class="mono">${esc(w ? w.surf : "")}<div class="note">${esc(l)}</div></td><td>${esc(w ? w.licensee : "")}${w&&w.nominated?'<div class="note">Nominated</div>':""}${w&&w.openLeak?'<div class="note st-issue">Open leak report</div>':""}</td>
      <td>${esc(r?.land?.owner || "")}${r?.land?.phone?`<div class="note">${esc(r.land.phone)}</div>`:""}${r?.land?.accessDate?`<div class="note st-done">Access ${esc(fmtDate(r.land.accessDate))}</div>`:""}</td>${cells}</tr>`; }).join("");
  $("pkgReportBody").innerHTML = `<div>
    <h1>${esc(p.name)}</h1>
    <p class="note">Well Closure Field App work package report · generated ${esc(when(new Date().toISOString()))}</p>
    <div class="meta" style="margin-top:12px">
      <div><span>Crew lead</span>${esc(p.crew||"Not assigned")}</div><div><span>Contractor</span>${esc(p.contractor||"Not recorded")}</div>
      <div><span>Start</span>${esc(fmtDate(p.start)||"Not set")}</div><div><span>Target finish</span>${esc(fmtDate(p.target)||"Not set")}</div>
      <div><span>Wells</span>${g.wells} (${g.started} started)</div><div><span>Checklist steps done</span>${g.done} of ${g.total} (${g.total?Math.round(100*g.done/g.total):0}%)</div>
      <div><span>Open issues</span>${g.issue}</div><div><span>Access confirmed</span>${g.access} of ${g.wells}</div>
      ${km?`<div><span>Route between sites</span>about ${fmt(Math.round(km))} km, straight line</div>`:""}
    </div>
    ${p.notes?`<p style="margin-top:12px">${esc(p.notes)}</p>`:""}
    <h2>Wells in visit order</h2>
    <div class="tw"><table><thead><tr><th>#</th><th>Location</th><th>Licensee</th><th>Landowner</th>${STAGES.map(st => `<th>${esc(st.title)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
    <h2>Open issues</h2>
    ${issues.length?`<div class="tw"><table><thead><tr><th>Location</th><th>Stage</th><th>Step</th><th>Reading</th><th>Notes</th></tr></thead><tbody>${issues.map(x => `<tr><td class="mono">${esc(x.surf)}</td><td>${esc(x.stage)}</td><td>${esc(x.step)}</td><td class="num">${esc(x.reading)}</td><td>${esc(x.note)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="note">No open issues recorded.</p>`}
    <p class="note" style="margin-top:20px">Stage columns show steps done or not applicable out of the total, with open issues in brackets. Well status and licensee are from the AER file dated 30 January 2025. Checklist steps are a draft for engineering review.</p></div>`;
}

/* ================= routing ================= */
function go(h){ if (location.hash.slice(1) === h) route(); else location.hash = h; }
function show(id){ for (const v of ["siteView","sitesView","reportView","pkgsView","pkgView","pkgReportView"]) $(v).hidden = v !== id; if (id) { closeSheet(); if (selMode) setSelMode(false); } }
let siteReturn = "", lastHash = "";
async function route(){
  const h = location.hash.slice(1);
  if (h.startsWith("site-") && !lastHash.startsWith("site-") && !lastHash.startsWith("report-")) siteReturn = lastHash.startsWith("pkg-") || lastHash === "sites" ? lastHash : "";
  lastHash = h;
  if (h.startsWith("site-")){ show("siteView"); $("backFromSite").textContent = siteReturn.startsWith("pkg-") ? "‹ Package" : siteReturn==="sites" ? "‹ My sites" : "‹ Map"; const lic = h.slice(5); if (!cur || cur.licence !== lic) await openSite(lic); else renderSite(); }
  else if (h.startsWith("report-")){ const lic = h.slice(7); if (!cur || cur.licence !== lic) await openSite(lic); show("reportView"); renderReport(); }
  else if (h === "sites"){ show("sitesView"); renderSites(); }
  else if (h === "packages"){ show("pkgsView"); renderPkgs(); }
  else if (h.startsWith("pkg-")){ show("pkgView"); await renderPkg(h.slice(4)); }
  else if (h.startsWith("pkgreport-")){ const id = h.slice(10); if (!pkgs.has(id)){ go("packages"); return; } curPkg = pkgs.get(id); if (ids === null) await idsReady; show("pkgReportView"); renderPkgReport(); }
  else { show(""); if (W){ requestAnimationFrame(resize); if (cur && byLic){ const i = byLic.get(cur.licence); if (i !== undefined) showCard(i); } } }
}
addEventListener("hashchange", route);
$("openSites").onclick = () => go("sites");
$("openPkgs").onclick = () => go("packages");
$("backFromPkgs").onclick = () => go("");
$("backFromPkg").onclick = () => go("packages");
$("toPkgReport").onclick = () => go("pkgreport-" + curPkg.id);
$("backFromPkgReport").onclick = () => go("pkg-" + curPkg.id);
if (inFrame) $("printPkgReport").hidden = true; else $("printPkgReport").onclick = () => window.print();
$("backFromSite").onclick = () => go(siteReturn || "");
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
refreshPackages();
loadAll().catch(err => { $("loading").textContent = "The well data didn't load. Check your connection and reload."; console.error(err); });
if ("serviceWorker" in navigator && !inFrame && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
