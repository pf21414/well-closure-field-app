/* Well Closure Field App v0.3: sign-in and syncing with the shared Supabase database.
   The app keeps working from the device's own storage. When someone is signed in and has
   signal, changed packages and site records go up, and everyone else's changes come down.
   Tables and access rules: supabase-setup.sql. Photos: private bucket "photos", <licence>/<photo id>.jpg. */
(() => {
"use strict";
const SUPABASE_URL = "https://vdxvwvlnremoksnirvpt.supabase.co";
const SUPABASE_KEY = "sb_publishable_nE8H0HY7s2C0eVAJnPozzQ_93b3RG-3"; // publishable key: safe in the browser; the access rules protect the data

const A = window.WCFA; // the app's own functions, from app.js
const $ = id => document.getElementById(id);
const esc = A.esc;
const S = window.SYNC = { ready:false, user:null, email:"", role:null, name:"", team:[], state:"off", lastSync:null, pending:0, error:"" };

let sb = null;
try { if (window.supabase && window.supabase.createClient) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:"implicit" } }); } catch {}

/* ---------- small helpers ---------- */
const later = (a, b) => (a || "") >= (b || "") ? a : b;
const online = () => navigator.onLine !== false;
async function metaGet(k){ try { const r = await A.META.get(k); return r ? r.v : null; } catch { return null; } }
async function metaSet(k, v){ try { await A.META.put({k, v}); } catch {} }
const photoPath = (lic, id) => `${lic}/${id}.jpg`;

/* Site records: steps merge one by one (newest change wins), photos merge by id,
   landowner details and crew fields each take the newer edit. */
function mergeSite(local, remote){
  if (!local) return structuredClone(remote);
  if (!remote) return local;
  const out = {...local};
  out.well = local.well || remote.well;
  out.created = (local.created || "") < (remote.created || "") && local.created ? local.created : (remote.created || local.created);
  if ((remote.metaAt || "") > (local.metaAt || "")){ out.crew = remote.crew; out.contractor = remote.contractor; out.metaAt = remote.metaAt; }
  if ((remote.land?._at || "") > (local.land?._at || "")) out.land = {...remote.land};
  out.steps = {};
  const keys = new Set([...Object.keys(local.steps||{}), ...Object.keys(remote.steps||{})]);
  for (const k of keys){
    const l = local.steps?.[k], r = remote.steps?.[k];
    if (!l){ out.steps[k] = structuredClone(r); continue; }
    if (!r){ out.steps[k] = l; continue; }
    const base = (r.at || "") > (l.at || "") ? {...r} : {...l};
    const ph = new Map();
    for (const p of (l.photos||[])) if (p.id) ph.set(p.id, p);
    for (const p of (r.photos||[])) { if (!p.id) continue; const have = ph.get(p.id);
      if (!have) ph.set(p.id, {...p}); else if (p.deleted && !have.deleted) ph.set(p.id, {...have, deleted:true, blob:undefined}); }
    base.photos = [...ph.values(), ...(l.photos||[]).filter(p => !p.id)].sort((a,b) => (a.at||"").localeCompare(b.at||""));
    out.steps[k] = base;
  }
  out.updated = later(local.updated, remote.updated);
  return out;
}
/* What goes up: the record without photo files or device-only fields. */
function siteForServer(r){
  const c = {...r, steps:{}};
  delete c.dirty; delete c.syncedAt; delete c.syncError;
  for (const [k,d] of Object.entries(r.steps||{})) c.steps[k] = {...d, photos:(d.photos||[]).map(p => { const q = {...p}; delete q.blob; return q; })};
  return c;
}
function pkgForServer(p){ const c = {...p}; delete c.dirty; delete c.syncedAt; delete c.syncError; return c; }

/* ---------- sign-in ---------- */
async function loadMe(){
  S.user = null; S.email = ""; S.role = null; S.name = ""; S.team = [];
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  const u = data?.session?.user; if (!u) return;
  S.user = u; S.email = (u.email || "").toLowerCase();
  if (!online()){ const c = await metaGet("me"); if (c && c.email === S.email){ S.role = c.role; S.name = c.name; S.team = c.team || []; } return; }
  const { data:team, error } = await sb.from("team").select("email,name,role").order("name");
  if (error){ S.error = error.message; return; }
  S.team = team || [];
  const me = S.team.find(t => t.email === S.email);
  S.role = me ? me.role : null; S.name = me ? me.name : "";
  await metaSet("me", {email:S.email, role:S.role, name:S.name, team:S.team});
}
async function sendCode(email){
  if (!sb) throw new Error("The sign-in service didn't load. Check your connection and reload.");
  const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true, emailRedirectTo: location.origin + location.pathname } });
  if (error) throw error;
}
/* Accepts a 6-digit code, the sign-in link copied from the email, or the app address the link opened. */
async function verifyCode(email, input){
  const text = input.trim();
  let error;
  if (/^\d{6,10}$/.test(text.replace(/\s/g,""))) ({ error } = await sb.auth.verifyOtp({ email, token:text.replace(/\s/g,""), type:"email" }));
  else {
    let u; try { u = new URL(text); } catch { throw new Error("Paste the whole link from the email, or the 6-digit code."); }
    const h = new URLSearchParams(u.hash.replace(/^#/, ""));
    if (h.get("access_token") && h.get("refresh_token")) ({ error } = await sb.auth.setSession({ access_token:h.get("access_token"), refresh_token:h.get("refresh_token") }));
    else {
      const th = u.searchParams.get("token") || u.searchParams.get("token_hash");
      if (!th) throw new Error("That link doesn't look like a sign-in link. Copy the link from the sign-in email.");
      ({ error } = await sb.auth.verifyOtp({ token_hash:th, type:(u.searchParams.get("type") || "magiclink") }));
    }
  }
  if (error) throw error;
  await loadMe(); paint(); await syncNow(true); subscribe();
}
async function signOut(){
  const waiting = await countPending();
  if (sb) await sb.auth.signOut();
  S.user = null; S.role = null; S.email = ""; S.team = []; S.state = "off";
  await metaSet("lastPull", null); await metaSet("me", null);
  if (chan){ try { sb.removeChannel(chan); } catch {} chan = null; }
  paint(); A.route();
  if (waiting) A.toast(`Signed out. ${waiting} change${waiting>1?"s":""} on this device haven't been shared yet.`);
}

/* ---------- syncing ---------- */
let busy = false, again = false, timer = 0;
async function countPending(){
  let n = 0;
  try { for (const r of await A.DB.all()) if (r.dirty || !r.syncedAt) n++; for (const p of await A.PK.all()) if (p.dirty || !p.syncedAt) n++; } catch {}
  return n;
}
function schedule(ms = 2500){ clearTimeout(timer); timer = setTimeout(() => syncNow(), ms); }
async function syncNow(full){
  if (!sb || !S.user || !S.role || !online()){ S.pending = await countPending(); paint(); return; }
  if (busy){ again = true; return; }
  busy = true; S.state = "syncing"; S.error = ""; paint();
  try {
    await pushPackages();
    await pushSites();
    await pull(full);
    S.lastSync = new Date().toISOString(); S.state = "ok"; await metaSet("lastSyncAt", S.lastSync);
  } catch (e) {
    S.state = "error"; S.error = (e && e.message) || "Sync failed";
  }
  S.pending = await countPending();
  busy = false; paint();
  if (again){ again = false; schedule(500); }
}
async function pushPackages(){
  if (S.role !== "manager") return; // crews read packages; managers change them
  for (const p of await A.PK.all()){
    if (!p.dirty && p.syncedAt) continue;
    const crew = p.crewEmail && S.team.some(t => t.email === p.crewEmail) ? p.crewEmail : null;
    const { data, error } = await sb.from("packages").upsert({ id:p.id, data:pkgForServer(p), crew_email:crew, deleted:!!p.deleted }).select("updated_at").single();
    if (error){ p.syncError = error.message; await A.PK.put(p); continue; }
    if (p.deleted){ await A.PK.del(p.id); continue; }
    p.dirty = false; p.syncedAt = data.updated_at; delete p.syncError; await A.PK.put(p);
  }
  await A.refreshPackages();
}
async function pushSites(){
  for (const r of await A.DB.all()){
    if (!r.dirty && r.syncedAt) continue;
    // 1. photo files first, so the record never points at a missing file
    let photosOk = true;
    for (const d of Object.values(r.steps||{})) for (const p of (d.photos||[])){
      if (!p.id) p.id = "ph" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
      if (p.uploaded || p.deleted || !p.blob) continue;
      const { error } = await sb.storage.from("photos").upload(photoPath(r.licence, p.id), p.blob, { contentType: p.blob.type || "image/jpeg", upsert:true });
      if (error){ photosOk = false; r.syncError = error.message; } else p.uploaded = true;
    }
    if (!photosOk){ await A.DB.put(r); continue; }
    // 2. merge with whatever is on the server, then send the result up
    const { data:row, error:e1 } = await sb.from("sites").select("data,updated_at").eq("licence", r.licence).maybeSingle();
    if (e1){ r.syncError = e1.message; await A.DB.put(r); continue; }
    const merged = row ? mergeSite(r, row.data) : r;
    const { data, error } = await sb.from("sites").upsert({ licence:r.licence, data:siteForServer(merged) }).select("updated_at").single();
    if (error){ r.syncError = /row-level security/i.test(error.message) ? "Not shared: this well isn't in one of your packages." : error.message; await A.DB.put(r); continue; }
    merged.dirty = false; merged.syncedAt = data.updated_at; delete merged.syncError;
    // someone may have kept editing on this device while we were talking to the server
    const fresh = await A.DB.get(r.licence);
    const final = fresh && fresh.updated !== r.updated ? {...mergeSite(fresh, merged), dirty:true} : merged;
    await A.DB.put(final); A.siteChanged(final);
  }
  await A.refreshSites();
}
async function pull(full){
  const since = full ? null : await metaGet("lastPull");
  let newest = since;
  // packages
  let q = sb.from("packages").select("id,data,crew_email,deleted,updated_at");
  if (since) q = q.gt("updated_at", since);
  const { data:pk, error:e1 } = await q; if (e1) throw e1;
  const wells = new Set();
  for (const row of pk || []){
    newest = later(newest, row.updated_at);
    const local = await A.PK.get(row.id);
    if (row.deleted){ if (local) await A.PK.del(row.id); continue; }
    if (local && local.dirty) continue; // our unsent change goes up next round
    await A.PK.put({...row.data, crewEmail: row.crew_email || "", dirty:false, syncedAt: row.updated_at});
    for (const l of row.data.wells || []) wells.add(l);
  }
  // crews only see packages assigned to them: drop local copies of ones no longer assigned
  if (S.role === "crew" && full){
    const { data:all } = await sb.from("packages").select("id").eq("deleted", false);
    const keep = new Set((all||[]).map(r => r.id));
    for (const p of await A.PK.all()) if (p.syncedAt && !p.dirty && !keep.has(p.id)) await A.PK.del(p.id);
  }
  // sites: everything changed since last time, plus every well in a package that just arrived
  let qs = sb.from("sites").select("licence,data,updated_at");
  if (since) qs = qs.gt("updated_at", since);
  const { data:st, error:e2 } = await qs; if (e2) throw e2;
  const rows = new Map((st||[]).map(r => [r.licence, r]));
  const missing = [...wells].filter(l => !rows.has(l));
  for (let i = 0; i < missing.length; i += 150){
    const { data:more, error:e3 } = await sb.from("sites").select("licence,data,updated_at").in("licence", missing.slice(i, i+150));
    if (e3) throw e3; for (const r of more||[]) rows.set(r.licence, r);
  }
  for (const row of rows.values()){
    newest = later(newest, row.updated_at);
    const local = await A.DB.get(row.licence);
    const merged = mergeSite(local, row.data);
    merged.dirty = !!(local && local.dirty); if (!merged.dirty) merged.syncedAt = row.updated_at;
    await fetchPhotos(merged);
    const fresh = await A.DB.get(row.licence);
    const final = fresh && local && fresh.updated !== local.updated ? {...mergeSite(fresh, merged), dirty:true} : merged;
    await A.DB.put(final); A.siteChanged(final);
  }
  if (newest) await metaSet("lastPull", newest);
  await A.refreshPackages(); await A.refreshSites();
}
async function fetchPhotos(r){
  for (const d of Object.values(r.steps||{})) for (const p of (d.photos||[])){
    if (p.blob || p.deleted || !p.id) continue;
    const { data, error } = await sb.storage.from("photos").download(photoPath(r.licence, p.id));
    if (!error && data){ p.blob = data; p.uploaded = true; }
  }
}

/* ---------- live updates ---------- */
let chan = null;
function subscribe(){
  if (!sb || !S.user || chan) return;
  chan = sb.channel("wcfa").on("postgres_changes", {event:"*", schema:"public", table:"packages"}, () => schedule(800))
                          .on("postgres_changes", {event:"*", schema:"public", table:"sites"}, () => schedule(800)).subscribe();
}
addEventListener("online", () => schedule(500));
document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(500); });
setInterval(() => { if (!document.hidden) syncNow(); }, 60000);

/* ---------- status chip and account screen ---------- */
const when = iso => iso ? new Date(iso).toLocaleTimeString("en-CA", {hour:"numeric", minute:"2-digit"}) : "";
function statusText(){
  if (!sb) return {cls:"off", t:"Sharing unavailable (sign-in service didn't load)"};
  if (!S.user) return {cls:"off", t:"Not signed in · records stay on this device"};
  if (!S.role) return {cls:"warn", t:`${S.email} isn't on the team yet. Ask a manager to add you.`};
  const who = `${S.name || S.email} · ${S.role}`;
  if (!online()) return {cls:"warn", t:`${who} · offline${S.pending?`, ${S.pending} change${S.pending>1?"s":""} waiting`:""}`};
  if (S.state === "syncing") return {cls:"busy", t:`${who} · syncing…`};
  if (S.state === "error") return {cls:"warn", t:`${who} · last sync failed`};
  return {cls:"ok", t:`${who} · synced${S.lastSync?` ${when(S.lastSync)}`:""}${S.pending?` · ${S.pending} waiting`:""}`};
}
function paint(){
  const el = $("syncChip"); if (el){ const s = statusText(); el.dataset.s = s.cls; el.querySelector("span").textContent = s.t; }
  if (!$("accountView").hidden) renderAccount();
  A.syncPainted && A.syncPainted();
}
function renderAccount(){
  const b = $("accountBody");
  if (!sb){ b.innerHTML = `<div class="empty"><b>Sharing isn't available right now</b><span>The sign-in service didn't load. Check your connection and reload the app. Your records are safe on this device.</span></div>`; return; }
  if (!S.user){
    b.innerHTML = `<div class="acct">
      <h2>Sign in to share records</h2>
      <p class="note">Enter your email and we'll send you a sign-in link. No password needed.</p>
      <form id="signForm" class="pfields" autocomplete="on">
        <label class="wide">Email<input type="email" id="si-email" autocomplete="email" required placeholder="you@example.com" value="${esc(localStorageGet("wcfa-email"))}"></label>
        <div class="wide tools" style="margin:0"><button type="submit" id="si-send">Email me a sign-in link</button></div>
      </form>
      <form id="codeForm" class="pfields" hidden>
        <p class="note wide"><b>On this device, open the link in the email.</b> The app opens signed in. If you added the app to your iPhone home screen, the link opens Safari instead: press and hold the link in the email, choose Copy Link, and paste it here.</p>
        <label class="wide">Sign-in link (or code) from the email<input id="si-code" autocomplete="one-time-code" placeholder="Paste the link here"></label>
        <div class="wide tools" style="margin:0"><button type="submit" id="si-verify">Sign in</button><button type="button" class="ghost" id="si-back">Use a different email</button></div>
      </form>
      <p class="note" id="si-msg" role="status"></p></div>`;
    const msg = $("si-msg");
    $("signForm").onsubmit = async e => { e.preventDefault(); const email = $("si-email").value.trim().toLowerCase(); if (!email) return;
      $("si-send").disabled = true; msg.textContent = "Sending…";
      try { await sendCode(email); localStorageSet("wcfa-email", email); $("signForm").hidden = true; $("codeForm").hidden = false; msg.textContent = `Sign-in email sent to ${email}. It can take a minute; check your junk folder too.`; }
      catch (err) { msg.textContent = /fetch|network/i.test(err.message) ? "Couldn't reach the server. Check your signal and try again." : /rate|seconds|limit/i.test(err.message) ? "Too many sign-in emails sent recently. Wait a while and try again." : `Couldn't send the email: ${err.message}`; }
      $("si-send").disabled = false; };
    $("codeForm").onsubmit = async e => { e.preventDefault(); const code = $("si-code").value; if (!code.trim()){ msg.textContent = "Paste the link from the sign-in email."; return; }
      $("si-verify").disabled = true; msg.textContent = "Checking…";
      try { await verifyCode(localStorageGet("wcfa-email"), code); A.toast("Signed in."); }
      catch (err) { msg.textContent = /expired|invalid/i.test(err.message) ? "That link has expired or was already used. Send a new one." : `Couldn't sign in: ${err.message}`; $("si-verify").disabled = false; } };
    $("si-back").onclick = () => { $("codeForm").hidden = true; $("signForm").hidden = false; msg.textContent = ""; };
    return;
  }
  const s = statusText();
  const isMgr = S.role === "manager";
  b.innerHTML = `<div class="acct">
    <div class="syncbox" data-s="${s.cls}"><span class="dot"></span><span class="otxt">${esc(s.t)}${S.error?`<br><span class="note">${esc(S.error)}</span>`:""}</span></div>
    <div class="tools" style="margin:0 0 18px"><button type="button" id="ac-sync" ${S.role?"":"disabled"}>Sync now</button><button type="button" class="ghost" id="ac-out">Sign out</button></div>
    ${S.role ? `<p class="note">Signed in as <b>${esc(S.email)}</b>. ${isMgr ? "Managers see every package and site, and assign packages to crews." : "Crews see the packages assigned to them and can update those sites."} Changes sync whenever this device has signal.</p>` : ""}
    <h2 style="margin-top:22px">Team</h2>
    ${S.team.length ? `<div class="tw"><table class="teamt"><thead><tr><th>Name</th><th>Email</th><th>Role</th>${isMgr?"<th></th>":""}</tr></thead><tbody>
      ${S.team.map(t => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.email)}</td><td>${isMgr && t.email!==S.email ? `<select data-e="${esc(t.email)}" class="t-role" aria-label="Role for ${esc(t.name)}"><option value="crew" ${t.role==="crew"?"selected":""}>crew</option><option value="manager" ${t.role==="manager"?"selected":""}>manager</option></select>` : esc(t.role)}</td>${isMgr?`<td>${t.email!==S.email?`<button type="button" class="ghost danger t-rm" data-e="${esc(t.email)}">Remove</button>`:""}</td>`:""}</tr>`).join("")}
      </tbody></table></div>` : `<p class="note">No team list yet.</p>`}
    ${isMgr ? `<form id="addForm" class="pfields" style="margin-top:14px">
      <label>Name<input id="ad-name" required placeholder="Wayne Newby"></label>
      <label>Email<input type="email" id="ad-email" required placeholder="name@example.com"></label>
      <label>Role<select id="ad-role"><option value="crew">crew</option><option value="manager">manager</option></select></label>
      <div class="wide tools" style="margin:0"><button type="submit">Add to team</button></div>
      <p class="note wide">They sign in with this email using a 6-digit code. Nothing is sent until they ask for a code.</p></form>` : ""}
  </div>`;
  $("ac-sync").onclick = () => syncNow(true);
  $("ac-out").onclick = signOut;
  if (isMgr){
    $("addForm").onsubmit = async e => { e.preventDefault();
      const row = { name:$("ad-name").value.trim(), email:$("ad-email").value.trim().toLowerCase(), role:$("ad-role").value };
      const { error } = await sb.from("team").upsert(row); if (error){ A.toast(`Couldn't add: ${error.message}`); return; }
      await loadMe(); paint(); A.toast(`Added ${row.name}.`); };
    for (const s of b.querySelectorAll(".t-role")) s.onchange = async () => { const { error } = await sb.from("team").update({role:s.value}).eq("email", s.dataset.e); if (error) A.toast(error.message); await loadMe(); paint(); };
    for (const x of b.querySelectorAll(".t-rm")) x.onclick = async () => {
      if (!x.classList.contains("armed")){ x.classList.add("armed"); x.textContent = "Tap again"; setTimeout(() => { x.classList.remove("armed"); x.textContent = "Remove"; }, 4000); return; }
      const { error } = await sb.from("team").delete().eq("email", x.dataset.e); if (error) A.toast(error.message); await loadMe(); paint(); };
  }
}
function localStorageGet(k){ try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function localStorageSet(k, v){ try { localStorage.setItem(k, v); } catch {} }

/* ---------- start ---------- */
S.merge = mergeSite;
S.changed = () => { S.pending++; paint(); schedule(); };
S.syncNow = syncNow;
S.renderAccount = renderAccount;
S.ready = !!sb;
(async () => {
  const last = await metaGet("lastSyncAt"); S.lastSync = last;
  await loadMe(); S.pending = await countPending(); paint();
  if (S.user){ subscribe(); syncNow(); }
  if (sb) sb.auth.onAuthStateChange((ev, session) => {
    if (ev === "SIGNED_OUT"){ S.user = null; paint(); }
    if (ev === "SIGNED_IN" && session && (!S.user || S.user.id !== session.user.id)) setTimeout(async () => { await loadMe(); paint(); A.toast("Signed in."); await syncNow(true); subscribe(); if (location.hash.slice(1) === "account") A.route(); }, 0);
  });
})();
})();
