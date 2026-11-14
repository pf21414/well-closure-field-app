# Well Closure Field App — notes for Claude Code

Owner: Bob Parkinson. Part of the Abandoned Wells – Alberta venture. Design outline: ../Well Closure Field App - Version 1 Outline 2026-11-11.docx

- Plain HTML/CSS/JS, no build step and no framework. Keep it that way unless Bob asks.
- Data format (shared with the Alberta Well Closure Atlas): `data/wells_b64.txt` is base64 of 13-byte records (lon f32, lat f32, status u8, flags u8, licensee u16, fluid u8, little-endian). Flags: 1 nominated, 2 any leak report, 4 open leak report, 8 open and serious. `wells_ids.txt` has `licence,surface location` per row in the same order. `wells_meta.json` has licensee/fluid/status lookups and `vf` leak detail keyed by row index.
- IndexedDB database `well-field-app`, version 2. Store `sites` keyed by licence (photos are JPEG blobs inside each step; landowner details in `land`). Store `packages` keyed by id: {id, name, crew, contractor, start, target, notes, wells:[licence…] in visit order, created, updated}.
- Package files (`kind: "package"`, version 2) carry the package plus its site records with photos as data URLs. Import merges wells and keeps the newer site record by `updated`.
- Routes use the hash: #sites, #site-<licence>, #report-<licence>, #packages, #pkg-<id>, #pkgreport-<id>.
- Roadmap: ../../Well Closure Field App - Roadmap 2026-11-13.docx
- Checklists live only in `checklists.js` and are a draft for engineering review. Don't present them as AER requirements.
- Bump `VERSION` in `sw.js` whenever app files or data change. The service worker is network-first for app files and cache-first for data/; installs bypass the HTTP cache. GitHub Pages caches files for about 10 minutes, so a new version can take that long to show.
- Done: v0.1 map, search, checklists, photos, offline; v0.2 work packages, package report, package files, landowner details. Next: v0.3 shared cloud data and logins.

## v0.3 shared data (Supabase)
- Project: well-closure-field-app, org Alberta Well Closure Venture, region Canada (Central), Free plan. URL and publishable key are at the top of `sync.js` (the publishable key is meant to be public; never put the secret key in the app).
- Tables and access rules: `supabase-setup.sql` (team, packages, sites; private storage bucket `photos` at <licence>/<photo id>.jpg). Managers see all; crews see sites in packages where `crew_email` is theirs.
- Sign-in: emailed link (implicit flow). The default Supabase email has no code, so the app also accepts the pasted link (iPhone home-screen app). Editing the email needs custom SMTP.
- `sync.js` merges site records step by step (newest `at` wins), photos by id with deletions kept, `land._at` and `metaAt` for the rest. Packages: managers push, crews read.
- `supabase.js` is supabase-js 2.118.0 (UMD), vendored so the app works offline.
