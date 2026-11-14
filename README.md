# Well Closure Field App (v0.3 prototype)

A web app for field crews working on abandoned well closure in Alberta. v0.1 built 12 November 2026; v0.2 (work packages) 13 November 2026.

Live at https://pf21414.github.io/well-closure-field-app/

## What it does now

- **Map and search.** All 238,158 wells from the AER abandoned-well file (dated 30 January 2025), the same data as the Alberta Well Closure Atlas. Search by licence number, surface location (for example 16-02-073-06W4) or licensee.
- **Locate me and nearby wells.** Uses the phone's GPS to list the 15 closest wells awaiting reclamation.
- **Site records.** For any well, start a record with five stages: site assessment, leak checks, decommissioning, remediation and reclamation. Each step takes a status (done, issue, N/A), notes, a reading where one applies, and photos stamped with time and GPS location.
- **My sites.** A list of every site with a record and its progress.
- **Site report.** A one-page summary of a site's record, with photos, ready to print or save as PDF.
- **Work packages (v0.2).** Tap the box button on the map and drag around a group of wells, or add a single well from its card. Each package has a name, crew lead, contractor, start and target dates, notes, and a suggested visit order with straight-line distance.
- **Package report (v0.2).** Every well in visit order with progress by stage, landowner and access status, plus a list of open issues.
- **Send to a crew phone (v0.2).** Exports the package and its site records (with photos) as one file, shared by email or text. The crew taps Import package file. The same file brings the crew's records back to the office; the newer copy of each site record wins.
- **Shared data and logins (v0.3).** People on the team sign in with an emailed link. Managers see every package and site and assign packages to crews; crews see only their assigned packages. Records and photos sync to a Supabase database in Canada (Central) whenever there is signal, and keep working offline.
- **Landowner and access (v0.2).** Each site record has landowner name and contact, land title number, LINC, surface lease, access notes and the date access was confirmed.
- **Offline.** When served over https or from localhost, the app and well data are cached on the device so it works with no signal.

Records are saved on the device first. When someone is signed in, they also sync to the shared database. Database setup: `supabase-setup.sql` (run once in the Supabase SQL editor).

## Checklists are a draft

The stage steps in `checklists.js` are a starting point for the team's engineers to review. They are not yet a statement of AER requirements. Edit that file to change them; no other code needs to change.

## Files

| File | Purpose |
|---|---|
| index.html | Page layout |
| app.css | Look and feel (same palette as the Atlas) |
| app.js | Map, search, site records, report, storage |
| checklists.js | The stage checklists (edit here) |
| sw.js | Offline support |
| manifest.webmanifest, icon.svg | Lets phones install it to the home screen |
| data/ | Well data from the Atlas (see below) |

## Data files

The `data` folder needs these files from the Atlas: `wells_b64.txt`, `wells_ids.txt`, `wells_meta.json`, `basemap.json`, `program.json`. They come in `well-field-app-data.zip`; unzip it into the `data` folder.

## Running it

On a computer with Python: open a terminal in this folder and run `python -m http.server 8000`, then open http://localhost:8000. To use it on a phone in the field, it needs to be hosted on an https web address (GitHub Pages or Netlify both work and are free for this size).

## Suggested next steps

1. Engineers review the checklists.
2. Host it on https so phones can install it and work offline.
3. Work packages: group nearby wells and assign them to a crew.
4. Sync records to a shared cloud database.
