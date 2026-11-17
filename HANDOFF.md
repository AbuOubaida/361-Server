# Server 360 (repo "361-Server", package name "my-laragon") — Handoff for a new Claude session

> **LANGUAGE RULE (user's explicit instruction, session 9): ALWAYS reply in BANGLA (Bengali script, বাংলা) from the very first message.** The user types Banglish ("ami", "korte chai"); that does NOT mean you answer in Banglish. Technical terms, file names, commands, code stay in English. Do not start in English and do not ask which language. If you started wrong, switch at once.
> If he answers "buji ni" (did not understand): explain again in simpler words with ONE exact action (where to click / which command) and what result to expect.

## FILES OF THIS HANDOFF (changed in session 37 to make it small, nothing was deleted)
- **HANDOFF.md** (this file, small): rules, current state, release process, open items, key reference. READ ALL OF IT first.
- **HANDOFF-ARCHIVE.md**: the COMPLETE old handoff (sessions 2-37 history, old checklists, section 5 `main.js` architecture, section 6 verification status, section 8 old TODO). Do NOT read it top to bottom (~460 KB). Search it: `grep -n "keyword" /mnt/user-data/uploads/HANDOFF-ARCHIVE.md`, then `sed -n 'a,bp'` for the lines you need. If the user did not upload it, ask him to upload it only when you really need old details.

## PERMANENT RULES FOR EVERY SESSION (set by the user; keep this section at the top, never delete it)
1. **Language:** Bengali script from the first message (see above). Never Banglish.
2. **Read first, then speak:** read this WHOLE file before the first answer. Uploaded files may NOT be in the chat context (only the path is listed): open them from `/mnt/user-data/uploads/` with `view`/`bash` before saying anything about them. Never say "the file has / has not X" after reading only a part. If a file cannot be read, say so openly; never pretend to have reviewed code.
3. **Memory is OFF** in this account: HANDOFF.md (+ archive) is the only memory between sessions. Keep it accurate.
4. **Small steps, user tests on Windows:** his PC is Windows (project `I:\server-360`, Git Bash path `/i/server-360`; app data root is his choice, earlier `I:\custome`); Claude only has Linux with fake tools. Every code step = (a) say what changes and get his OK, (b) write complete files, (c) test on Linux, (d) say clearly what was NOT tested, (e) give a short numbered Windows check, small first. Do NOT start the next step before he reports the results the gate asks for.
5. **Delivering files:** write changed files to `/mnt/user-data/outputs/` and call `present_files`. List which files changed. Give the commit command in one line. He prefers COMPLETE replacement files, not snippets.
6. **Update HANDOFF.md at the end of every session or when he asks:** keep it SMALL. Add a short new dated block under "SESSION LOG", refresh "START HERE", and when the log gets long (more than ~5 blocks) move the oldest blocks word for word to the END of HANDOFF-ARCHIVE.md (never delete information). Deliver BOTH files when both changed. Remind him to replace the old files and push.
7. **Style:** short numbered steps, plain words, no long theory. Honest status: passed / failed / not tested. Test passwords typed in chat are throwaways; never reuse; never ask for real passwords.
8. **Safety:** restore features overwrite data. Defaults keep old data (keep both); overwrite needs a safety copy first; nothing is deleted if the safety copy fails.
9. **Git Bash gotcha:** he uses Git Bash (MINGW64). A backslash path like `dir node_modules\x` loses the `\` there. Give Git Bash commands with `/` (`ls node_modules/electron-updater`). Use `cmd` only if a Windows-style command is really needed, and say so.
10. Claude cannot push to git, cannot run Electron/Windows, has no network. Say honestly what was and was not verified on real Windows.

## START HERE (updated end of SESSION 37, 2026-11-17)
**State: everything asked so far is DONE, Windows-confirmed and pushed. Nothing is half-written.** Latest commit `a000420` "Version 1.0.3 (auto-update verified)" on `main` (before it `17be1f1`). App version is **1.0.3**. Do not ask again about: sidebar toggle, `.gitignore`, installer 1.0.0/1.0.1, upgrade over an older Setup, auto-update, the lock file.

**What exists (all Windows-confirmed unless marked):** web servers (Apache/Nginx) + PHP versions + vhosts `*.test`, MySQL, PostgreSQL, MongoDB (+ Mongo Express, Adminer, phpMyAdmin), Node sites (templates, per-site Node version, auto-start), SSL on Nginx, per-site config files (`sites-enabled`), Backup (7-Zip, local/network, Task Scheduler, MongoDB dump) and full Restore, R1 site monitoring (up/down, CPU/RAM, hits per site, top URLs, e-mail alerts with own SMTP client), R5 search boxes, R6 themes, tray + auto-start, Windows installer (NSIS) and **auto-update (electron-updater + GitHub Releases)**.

**FIRST ACTION of the next session:** reply in Bangla script, say in 3 lines where we stopped (everything done, version 1.0.3), then ask ONCE (tappable list) what he wants next. Do not start a feature before he answers.

**Open items (none started; he has not chosen):**
- Features: portable build; pgweb (PostgreSQL viewer, small Go exe); MariaDB; Redis; **R3** remote database; **R4** load balancing; Git import of projects (clone, composer/npm install, `.env`); Apache SSL (https works on Nginx only); real Let's Encrypt certificate on the SERVER PC (staging then real, auto-renew); several DB versions running at once on different ports; `npm audit` (1 high vulnerability seen long ago).
- Small leftovers: symlink/junction under www (needs `dir /AL` output + decision); Task Scheduler backup run with MongoDB stopped (untested); automatic `mongodump.exe` download never seen in a log (tools exist, dump works); Mongo Express port changes at every start (remember the last port? needs his OK); F3 `laravel-app.test` uptime (optional); cosmetic: the `›` tab sits tight against the logo when the sidebar is collapsed, no tooltips on collapsed icons, full "SERVER 360°" logo at the top.
- Not tested on Windows: **PowerShell OFF** (a second PC has PowerShell disabled by antivirus). Features that call PowerShell: hosts-file write with UAC (`main.js` ~1326), killing processes (~1716), three UAC `cmd` runs (~2939, ~2962, ~4037), 7-Zip UAC fallback (`backup.js` ~495); `.test` hosts line, Task Scheduler, firewall untested without PowerShell. The app's own 7-Zip download + UAC fallback on a clean PC is untested (he said "eta lagbe na", do not push). SmartScreen on the unsigned Setup/updates: not reported. Whether the second PC has Node: not confirmed.
- Old TODO list (section 8 of the archive) is mostly done or superseded; this list is the current one.

## RELEASE / UPDATE PROCEDURE (user asked to keep this; follow it for every new version)
Facts: updater = `updater.js` + `electron-updater ^6.3.9`; `build.publish` = GitHub `AbuOubaida/361-Server`; `npm run dist` = `electron-builder --win nsis --publish never` (never uploads). Update flow is by BUTTONS only (Settings > "অ্যাপের আপডেট"): Check -> Download (progress bar) -> Restart and install (warns that servers stop). Nothing downloads/installs/restarts by itself. Works only in the INSTALLED app (not `npm start`, not `dist\win-unpacked` is fine but use the installed copy for tests). Auto check ~10 s after start when the switch is on (default on).
1. `git pull` state clean. Make the changes. If a new npm dependency was added: run `npm install` and check `ls node_modules/<package>` BEFORE `npm run dist` (session 37: the first 1.0.2 build lacked `electron-updater` because `npm install` had not been run; the app showed `Cannot find module 'electron-updater'`).
2. `npm version <new> --no-git-tag-version` (e.g. 1.0.4), then **commit + push the version bump FIRST** (`git add package.json package-lock.json && git commit -m "Version <new>" && git push`) so the GitHub tag points at the right commit (v1.0.3's tag points at `17be1f1`, one commit before the bump `a000420`: harmless, the exe is what counts).
3. Close the app and any Explorer window on `dist` (else `EBUSY`), run `npm run dist`. Output in `dist\`: `Server-360-Setup-<new>.exe`, `.exe.blockmap`, `latest.yml` (never commit `dist/`).
4. GitHub > Releases > **Draft a new release** (NOT the edit page of an old one): tag `v<new>` (create new tag), title `v<new>`, upload exactly those 3 files, release label **Latest** (not Pre-release), **Publish**.
5. **Do NOT run `npm run dist` again for that version after uploading** (the exe changes and no longer matches the hash in `latest.yml`; if you must rebuild, upload all 3 files again).
6. Test from the PREVIOUS installed version: Check -> Download -> Restart and install; check version, ports, sites, data.
7. NEVER mark as Latest: release `v1` (the TOOLS release the app downloads from) and the old pre-release `app-v1.0.0` (tag `setup-v1`, holds `Server-360-Setup-1.0.0.exe`). Do not edit those. If `v1` is the Latest release the update check fails with `Cannot find latest.yml in the latest release artifacts (.../releases/download/v1/latest.yml)`: that exact text was seen on 1.0.2 before `v1.0.3` existed and is the normal result when no newer Latest release exists.
8. The Setup is unsigned: SmartScreen may warn. Versions before 1.0.2 have no updater (1.0.1 users must install 1.0.2+ by hand once).

## SESSION LOG (newest first; keep short; older blocks go to the archive)
### Session 37 (2026-11-17): installer checks, AUTO-UPDATE written AND Windows-confirmed
- Installer 1.0.1: toggle works; upgrade over 1.0.0 passed (one entry, data/ports kept); setup installed on a second PC (7-Zip was already installed by him there).
- Auto-update plan approved ("ok"), code written (`updater.js` new; `main.js` 4 small edits; `preload.js`, `renderer.js`, `i18n.js` (bn = en = 628 keys, every key exactly twice), `index.html`, `package.json`), Linux-tested with a fake updater and headless Chromium.
- Windows results, in order: (1) `npm install` + `npm start`: card showed the source-run message; committed (his word). (2) `npm run dist` of 1.0.2: first build had NO `electron-updater` inside (`Cannot find module`, screenshot) because `npm install` was missing; after `npm install` (`ls node_modules/electron-updater` showed LICENSE, README.md, node_modules/, out/, package.json) and `npm run dist` it worked. (3) Installed 1.0.2: Check gave the red `latest.yml` not found text (URL `.../releases/download/v1/latest.yml`), expected, this also proved the real GitHub contact and that the repo is PUBLIC. (4) He made release `v1.0.3` (Latest, 3 files, `.exe` 117 MB). (5) From installed 1.0.2: Check -> Download -> Restart and install -> **1.0.3 installed in place (his answer: yes)**. Screenshot: version 1.0.3, "up to date" (last check 12:39:24 PM); at 12:41 Start All worked: Apache (4 sites), MySQL 3306, PostgreSQL 5432, MongoDB 27017, `nx.test` Node 24.22.2 on port 3103 all started. (6) Commit `a000420` pushed.
- NOT reported by him (do not claim): whether the progress bar and the "servers will stop" warning appeared, whether the app reopened by itself, SmartScreen/UAC on the update, the English look of the card.
- Mistake worth remembering: Claude's first asks used Windows `dir node_modules\...` in Git Bash and the `\` was lost (rule 9).

### Session 36 (2026-11-15 to 17): Windows installer
- `electron-builder` NSIS Setup, per-user, not one-click, folder selectable, desktop + Start menu shortcut (`Server-360-Setup-${version}.exe`); `asar: false`; app icon in `build/` (`icon.ico`, `icon.png`, `tray.png`, `logo.png`); `build.files` lists: `main.js preload.js renderer.js i18n.js index.html backup.js monitor.js resources.js traffic.js mailer.js updater.js mongo.js mongoexpress.js build/* package.json` (add every new `require('./x')` file here). `check-node.js` + `.nvmrc` + `engines >=22.12.0` only help source runs (installed app needs no Node).
- 7-Zip: existing release asset `https://github.com/AbuOubaida/361-Server/releases/download/v1/7z2606-x64.exe` stays; UAC prompt accepted; `find7z()` also accepts `C:\Program Files\7-Zip`, `Program Files (x86)` and `<tools>\7zip`.
- UI added: red "Quit app" button (confirm, IPC `app:quit`), language/theme at the bottom of the sidebar, sidebar collapse tab (state remembered), menu name "Backup & Restore", logo in the sidebar.
- Tools (web server, PHP, databases, 7-Zip...) are downloaded by the app on first use from the GitHub release `v1`; needs internet.

### Sessions 2-35 (summary; full text in the archive)
Base app + services + vhosts + PHP versions + Node sites; Backup (7-Zip, schedule, Task Scheduler) and Restore steps 1-5 (www, MySQL, PostgreSQL, settings/certificates, extras, original-path restore, `-restored` DB name fix); R5 search boxes, R6 themes; R1 monitoring steps 1-4 (monitor.js, resources.js, traffic.js, mailer.js); R2 MongoDB (service, Mongo Express, dump, restore). Search the archive by these names or by `session N`.

## KEY REFERENCE (copied word for word from the old sections 1, 2, 3, 7; for section 4 see the file list below; section 5 = main.js architecture is in the archive)

### FILE LIST (current, 2026-11-17; the old section 4 in the archive is outdated)
Project root `I:\server-360`: `main.js` (all main-process logic, IPC), `preload.js` (window.api bridge), `renderer.js`, `index.html`, `i18n.js` (bn/en dictionaries, keys must match, each key exactly twice), `backup.js`, `monitor.js`, `resources.js`, `traffic.js`, `mailer.js` (own SMTP client), `updater.js` (auto-update), `mongo.js` (OP_MSG shutdown/listDatabases/dropDatabase), `mongoexpress.js`, `check-node.js`, `.nvmrc`, `package.json`, `package-lock.json`, `README.md`, `.gitignore` (`node_modules/`, `backup-secrets.ini`, `*.cnf`, `*.7z`, `backup/`, `dist/`), `build/` (icons). Runtime data lives under ROOT (tools, data, www, settings), not in the repo. Uploaded source files are the source of truth; `main.js` is very large: use `grep -n` and read only the needed parts.

#### 1. Goal
Build **their own Laragon-like desktop app** called **Server 360** (Electron, Windows): start/stop web servers and databases, auto-download everything needed,
virtual hosts (`blog.test`), per-site PHP versions, Adminer/phpMyAdmin, and later one-click app installers (WordPress, Laravel).

**Naming rule (important):** the UI/window name is "Server 360", but `package.json` name stays `my-laragon`, the hosts markers stay `# my-laragon begin/end`,
and the data folder stays `%APPDATA%\my-laragon`. Renaming those would orphan the user's settings, MySQL data and tools. Do not rename them.

#### 2. Tech stack / environment
- **Electron** (`^45.2.3`) + Node.js **v22.23.2** (Electron 45 needs Node >= 22.12). Plain JS (CommonJS), no framework, no bundler.
- npm packages: `electron` (dev), `extract-zip`. (`npm audit` shows 1 high vulnerability — not addressed yet.)
- `package.json`: `"main": "main.js"`, `"scripts": { "start": "electron ." }`. Run with `npm start`. Close the app window to quit (Ctrl+C in the terminal leaves orphan servers).
- Windows-only for now (uses `taskkill`, `reg query`, PowerShell, `tar.exe`, `hosts` file).
- GitHub repo: `https://github.com/AbuOubaida/361-Server` (must stay **Public**; `.gitignore` has `node_modules/`).

#### 3. GitHub Release `v1` assets (downloaded by the app at first use)
Links are `https://github.com/AbuOubaida/361-Server/releases/download/v1/<file>`:

| Component | File | Notes |
|---|---|---|
| Apache | `httpd-2.4.70-261106-Win64-VS18.zip` | Apache Lounge VS18 build; top folder `Apache24` |
| Nginx | `nginx-1.30.6.zip` | nginx.org **Stable** |
| win-acme | `win-acme.v2.2.9.1701.x64.pluggable.zip` | uploaded 2026-11-10 for Part B2 (Let's Encrypt client); NOT yet used by the app |
| PHP | `php-8.5.12-1-nts-Win32-vs17-x64.zip` | **NTS x64**; files at zip root. Note the `-1` |
| MySQL | `mysql-8.4.13-winx64.zip` | 8.4 LTS on purpose |
| PostgreSQL | `postgresql-18.6-5-windows-x64-binaries.zip` | EDB binaries zip (~300MB), top folder `pgsql` (works, confirmed) |
| Node.js | `node-v24.22.2-win-x64.zip` | Node 24 LTS (Krypton, supported to 2028-04); top folder `node-v24.22.2-win-x64` with `node.exe`, `npm.cmd` |
| Adminer | `adminer-5.5.1.php` | single PHP file |
| phpMyAdmin | `phpMyAdmin-5.2.3-all-languages.zip` | |

VC++ Redistributable is downloaded from `https://aka.ms/vc14/vc_redist.x64.exe` and installed silently (UAC) if
`HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` `Installed` != 1.


#### 7. Lessons / gotchas already hit (don't repeat)
- Two nginx instances can bind the same port silently on Windows -> always clean stale processes (done, inside our tools dir only).
- A synchronous dialog before the page loads gives a blank window; use async after `did-finish-load`.
- php-cgi default port 9000 can be taken -> random free port per PHP version.
- Apache Lounge ships **VS18** builds (needs latest VC++ redistributable).
- Keep guessed download filenames in sync with the real release assets (PHP `-1`, MySQL patch, PostgreSQL `18.6-5`).
- `.test` in Chrome: type `http://` explicitly. Hosts edits need UAC; if refused only `localhost` works.
- `extract-zip` silently hung on the ~300MB PostgreSQL zip -> use `tar.exe` first with a timeout fallback; download via `.part` file.
- Apache: do **not** rely on uncommenting `#LoadModule` in `httpd.conf` (gave `Invalid command 'ProxyTimeout'`); load modules from our own `server360.conf` with `IfModule` guards. PHP runs through mod_cgi/mod_actions, not mod_proxy_fcgi.
- Apache CGI on Windows does not pass `TEMP`, so PHP wrote sessions to `C:\Windows` -> "session_start(): Permission denied" in phpMyAdmin. Fixed by setting `session.save_path` etc. in php.ini.
- CSS: a generic `.btn:hover` turned coloured buttons white-on-white; hover must exclude `.primary/.danger/.accent`.
- One php-cgi serves one request at a time; a single worker made WordPress-style loopback requests hang. Hence several workers behind an Nginx `upstream` (`max_fails=0` so a busy/slow worker is not marked down).
- `php-cgi` ignores `fastcgi_param PHP_VALUE` / `PHP_ADMIN_VALUE` (php-fpm only): the value shows in `$_SERVER` but `ini_get` stays default. Use the `auto_prepend_file` + `S360_SESSION` approach for per-site ini values.
- Windows console Apache: `httpd -k restart` does nothing useful; restart by stopping and starting the process.
- Do not rename `package.json` name / hosts markers / data folder (see section 1).

