# Well Closure Field App (v0.1 prototype)

A web app for field crews working on abandoned well closure in Alberta. Built in Claude Code, 12 November 2026.

## What it does now

- **Map and search.** All 238,158 wells from the AER abandoned-well file (dated 30 January 2025), the same data as the Alberta Well Closure Atlas. Search by licence number, surface location (for example 16-02-073-06W4) or licensee.
- **Locate me and nearby wells.** Uses the phone's GPS to list the 15 closest wells awaiting reclamation.
- **Site records.** For any well, start a record with five stages: site assessment, leak checks, decommissioning, remediation and reclamation. Each step takes a status (done, issue, N/A), notes, a reading where one applies, and photos stamped with time and GPS location.
- **My sites.** A list of every site with a record and its progress.
- **Site report.** A one-page summary of a site's record, with photos, ready to print or save as PDF.
- **Offline.** When served over https or from localhost, the app and well data are cached on the device so it works with no signal.

Records are saved in the browser on that device only. Syncing between devices is a later step.

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
