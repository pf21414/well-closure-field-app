# Well Closure Field App — notes for Claude Code

Owner: Bob Parkinson. Part of the Abandoned Wells – Alberta venture. Design outline: ../Well Closure Field App - Version 1 Outline 2026-11-11.docx

- Plain HTML/CSS/JS, no build step and no framework. Keep it that way unless Bob asks.
- Data format (shared with the Alberta Well Closure Atlas): `data/wells_b64.txt` is base64 of 13-byte records (lon f32, lat f32, status u8, flags u8, licensee u16, fluid u8, little-endian). Flags: 1 nominated, 2 any leak report, 4 open leak report, 8 open and serious. `wells_ids.txt` has `licence,surface location` per row in the same order. `wells_meta.json` has licensee/fluid/status lookups and `vf` leak detail keyed by row index.
- Site records are in IndexedDB, database `well-field-app`, store `sites`, keyed by licence. Photos are JPEG blobs inside each step.
- Checklists live only in `checklists.js` and are a draft for engineering review. Don't present them as AER requirements.
- Bump `VERSION` in `sw.js` whenever app files or data change.
- Build order from the outline: map and search (done), single-well checklist with photos (done), offline (done, needs https hosting), work packages, PDF reports, sync.
