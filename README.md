# Bibbs Zone Audit

Installable web app (PWA) showing Michigan's published MDOT RIDE work-zone
listings, with a "Report what you saw" flow that saves factual road
observations on the user's phone.

Live at: https://lbibbs312.github.io/bibbs-zone-audit/

## How it works

- A scheduled GitHub Action calls the documented MDOT RIDE
  `work_zone_information` endpoint about every 30 minutes and publishes a
  sanitized `zones.json` (whitelisted WZDx fields only) together with the
  static site to GitHub Pages.
- The API key lives only in the repository secret `MDOT_RIDE_API_KEY`. The
  publisher refuses to write output that contains the key bytes. No key is
  ever present in this repository or on the site.
- Reports (answers, GPS as observed, original photo files) are stored in
  the browser's IndexedDB on the device. Nothing is uploaded anywhere; the
  user exports a report as a JSON file plus the original photographs.

## Boundaries

This is an independent Bibbs Technology LLC tool. It reads MDOT's published
feed and does not modify MDOT systems, control signs, submit anything to
MDOT, or claim MDOT endorsement. Location shown in the app is supporting
context, not proof of what a photograph shows.
