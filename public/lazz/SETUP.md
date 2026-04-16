# The Lazz — Bracket Setup

A single HTML page that displays "The Lazz" team match-play bracket.
The Pro Shop updates a Google Sheet; the page reads the sheet and renders the bracket. No login, no server, no database.

## Files in this package
- `index.html` — the bracket page. Embed or host this.
- `banner.jpg` — the hero photo (Meadow Club 3rd hole). **Must live in the same folder as `index.html`.**
- `lazz-sheet-template.csv` — import this into a new Google Sheet to get the starting layout.
- `SETUP.md` — this file.

---

## One-time setup (15 min)

### 1. Create the Google Sheet
1. Go to https://sheets.new (or File → New in Google Sheets).
2. File → Import → Upload → choose `lazz-sheet-template.csv` → **Replace spreadsheet**.
3. You should now see a sheet with:
   - Rows 2–33: the 32-team roster (seed + team name).
   - Rows 34–64: the 31 matches (M1–M31), empty winner column.
4. Rename the file to something like "The Lazz 2026 — Bracket".

### 2. Fill in the team roster
- In column B (`name`), replace "Team 1", "Team 2", etc. with the actual partnership names (e.g., `Krepelka / Furst`).
- Keep the `seed` column (A) intact. Seeds must be 1–32, no duplicates.

### 3. Add a dropdown for the winner column (optional but recommended)
This prevents typos when entering results.
1. Select cells `D34:D64` (the `winner` column for all 31 matches).
2. Data → Data validation → Add rule.
3. Criteria: **Dropdown** → list items: `top` and `bottom`.
4. Save.

Now whoever updates the sheet just picks `top` or `bottom` from a dropdown.

### 4. Publish the sheet as CSV
1. File → **Share** → **Publish to web**.
2. Under "Link": leave "Entire document" and change the format to **Comma-separated values (.csv)**.
3. Click **Publish** → **OK** to confirm.
4. Copy the URL it gives you. It looks like:
   `https://docs.google.com/spreadsheets/d/e/2PACX-1vXXXXXX/pub?output=csv`

### 5. Paste the URL into the HTML
1. Open `index.html` in any text editor.
2. Find the line near the top of the `<script>` block:
   ```js
   const SHEET_CSV_URL = "";
   ```
3. Paste the URL between the quotes:
   ```js
   const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1v.../pub?output=csv";
   ```
4. Save.

### 6. Host the page
Give `index.html` to the webmaster. They can:
- Upload it to the club's web server (e.g., `meadowclub.com/lazz/index.html`), OR
- Embed the page in an iframe on an existing page:
  ```html
  <iframe src="https://yourclub.com/lazz/index.html" style="width:100%;height:1400px;border:0;"></iframe>
  ```

---

## How the Pro Shop updates results

You have two ways to update winners. **Use either — not both at the same time.**

### Method A (recommended) — Click on the website

1. Scroll to the footer of the bracket page.
2. Click **Pro Shop Login**.
3. Username: `proshop` &nbsp; Password: `mttam`
4. A dark green admin bar appears at the top. Click a team name to advance them. Click again to undo. Winners propagate to later rounds automatically.
5. When you're done for the day (or after a set of matches), click **Sync to Google Sheet** in the admin bar. A window opens with a block of text.
6. Click **Copy to clipboard**, switch to the Google Sheet, click cell **`D34`**, and paste. Done — all viewers of the website will see the updated bracket within ~30 seconds.
7. Click **Exit Admin** (or **Logout** in the admin bar) when finished.

**Why the sync step?** Picks are stored in the Pro Shop's browser (private to that device) until synced. Syncing writes them to the Google Sheet, which is what everyone else sees.

### Method B — Edit the Google Sheet directly

1. Open the Google Sheet.
2. Find the match row (e.g., `M1`, `M2` — see the bracket key below).
3. In the `winner` column, pick `top` or `bottom`:
   - `top` = the team listed in the upper slot of that match on the bracket
   - `bottom` = the team in the lower slot
4. (Optional) type the score into the `score` column, e.g., `3 & 2`.
5. The website updates within ~30 seconds.

---

## Admin login — notes on security

The login (`proshop` / `mttam`) is a simple client-side check. It keeps casual visitors from accidentally clicking winners, but it isn't real security — a determined user could read the source. For the use case (club website, no adversarial risk), this is intentional: no server, no database, no hosting complexity.

To **change the password**, open `index.html` and edit these two lines near the top of the `<script>` block:
```js
const ADMIN_USERNAME = "proshop";
const ADMIN_PASSWORD = "mttam";
```

### Bracket key — which match is which (2026 draw)

Teams are listed here in the order they appear on the paper bracket (top → bottom). `top` = the team listed first; `bottom` = the team listed second.

**Round of 32** (16 matches):
- M1:  (1) Koagedal / Porter         vs  (32) Wheelock / Ferst
- M2:  (16) Park / Solter            vs  (17) Wu / Tiret
- M3:  (9) Lateef / P. Bjursten      vs  (24) Chang / Z. Hyman
- M4:  (8) Friedman / Pilger         vs  (25) Lance / Oppenheim
- M5:  (4) Dowd / Bartsh             vs  (29) Dresser / Borden
- M6:  (13) MacKay / Nutting         vs  (20) Cook / Cinelli
- M7:  (12) Coduto / Ortiz           vs  (21) Mayeda / D. Thompson
- M8:  (5) Nelson II / Morgan        vs  (28) Tilney / Morrison
- M9:  (2) Zerbe / Fradelizio        vs  (31) Russell / AbouKhater
- M10: (15) Mitchell / Levitan       vs  (18) Herbst / Eiseman
- M11: (10) Miller / M. Hyman        vs  (23) Henderson / Rivers
- M12: (7) Herzog / Gordon           vs  (26) H. Klein / Ross
- M13: (3) Levine / Zlot             vs  (30) Thornton / Fish
- M14: (14) Hamill / Cussen          vs  (19) Tupper / Aanes
- M15: (11) Zintak / Mortimer        vs  (22) Eesley / R. Gibson
- M16: (6) De Surville / A. Ryan     vs  (27) McKinley / Gottschalk

**Round of 16** (M17–M24) — winners of M1/M2, M3/M4, etc.
**Quarterfinals** (M25–M28)
**Semifinals** (M29–M30)
**Championship** (M31)

The top/bottom mapping for later rounds follows the bracket order shown on the webpage. When in doubt, open the live page after entering a R32 winner — the advanced team will appear in its next match so you can confirm which slot is `top` vs `bottom`.

---

## Troubleshooting

**The page says "Preview mode · connect Google Sheet in index.html"**
The `SHEET_CSV_URL` is blank. Go back to Step 5.

**The page says "Could not load live bracket"**
Usually means the sheet hasn't been published (Step 4), or the URL was copied incorrectly. Re-check the publish settings — it must be CSV format, not HTML.

**My change to the sheet isn't showing up**
Google caches published sheets for ~30–60 seconds. Wait a minute, then click **Refresh** on the page. Hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) if needed.

**The bracket shows "TBD" where a team should be**
Either (a) the R32 match feeding that slot hasn't had a winner entered yet, or (b) the team roster is missing an entry for that seed.

**I need to change a team name mid-tournament**
Edit the sheet — the name updates everywhere (including matches already played) within 30–60 seconds.

**I entered the wrong winner**
Change the dropdown value in the sheet. All downstream matches re-resolve automatically.

---

## What's NOT in this package
- No login / authentication — anyone who has edit access to the Google Sheet can update results. Control this the normal Google Sheets way (File → Share).
- No match history or archive. Each year, make a copy of the sheet for a new season.
- No live scoring — results appear after the Pro Shop enters them, not during play.

---

## Questions?
The page is a single HTML file with inline CSS/JS — no build step, no dependencies. A webmaster can open it in a text editor to tweak colors, copy, or layout.
