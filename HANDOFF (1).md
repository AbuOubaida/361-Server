# Server 360 (repo "361-Server", package name "my-laragon") — Handoff for a new Claude session

Last updated: 2026-11-09 (end of session: multi-worker php-cgi + blank/WordPress creator done and confirmed; everything pushed except what the user reports otherwise).

## 0. How to use this document
The user will paste this at the start of a new session and (ideally) upload the current project files:
`main.js`, `preload.js`, `renderer.js`, `i18n.js`, `index.html`, `package.json`.
**Read the uploaded files first**; they are the source of truth. If they are not uploaded, ask for them
(or for the GitHub repo link below) before changing anything.

**User & style**
- The user writes Bengali / Banglish ("ami", "korte chai") and wants replies in **Bengali** (technical terms in English are fine).
- They prefer: small steps, **complete replacement files** (not partial snippets), and exact commands.
- They send screenshots of errors/results; read them carefully. When a step needs a download, they download the zip, upload it to the GitHub Release, and send back the URL.
- They use **Git Bash (MINGW64)** on Windows. Project dir: `/i/my-laragon` (Windows `I:\my-laragon`). Machine user seen: `Oubaida`.
- The user's install folder (ROOT) is `I:\custome` (tools in `I:\custome\tools`, data in `I:\custome\data`, www in `I:\custome\www`).
- Claude cannot run the app on Windows. Everything is tested only with fake binaries / a fake Electron on Linux. Always say honestly what was and was not verified on real Windows.
- Claude cannot push to git; give the user the commands (`git add . && git commit -m "..." && git push`).

## 1. Goal
Build **their own Laragon-like desktop app** called **Server 360** (Electron, Windows): start/stop web servers and databases, auto-download everything needed,
virtual hosts (`blog.test`), per-site PHP versions, Adminer/phpMyAdmin, and later one-click app installers (WordPress, Laravel).

**Naming rule (important):** the UI/window name is "Server 360", but `package.json` name stays `my-laragon`, the hosts markers stay `# my-laragon begin/end`,
and the data folder stays `%APPDATA%\my-laragon`. Renaming those would orphan the user's settings, MySQL data and tools. Do not rename them.

## 2. Tech stack / environment
- **Electron** (`^45.2.3`) + Node.js **v22.23.2** (Electron 45 needs Node >= 22.12). Plain JS (CommonJS), no framework, no bundler.
- npm packages: `electron` (dev), `extract-zip`. (`npm audit` shows 1 high vulnerability — not addressed yet.)
- `package.json`: `"main": "main.js"`, `"scripts": { "start": "electron ." }`. Run with `npm start`. Close the app window to quit (Ctrl+C in the terminal leaves orphan servers).
- Windows-only for now (uses `taskkill`, `reg query`, PowerShell, `tar.exe`, `hosts` file).
- GitHub repo: `https://github.com/AbuOubaida/361-Server` (must stay **Public**; `.gitignore` has `node_modules/`).

## 3. GitHub Release `v1` assets (downloaded by the app at first use)
Links are `https://github.com/AbuOubaida/361-Server/releases/download/v1/<file>`:

| Component | File | Notes |
|---|---|---|
| Apache | `httpd-2.4.70-261106-Win64-VS18.zip` | Apache Lounge VS18 build; top folder `Apache24` |
| Nginx | `nginx-1.30.6.zip` | nginx.org **Stable** |
| PHP | `php-8.5.12-1-nts-Win32-vs17-x64.zip` | **NTS x64**; files at zip root. Note the `-1` |
| MySQL | `mysql-8.4.13-winx64.zip` | 8.4 LTS on purpose |
| PostgreSQL | `postgresql-18.6-5-windows-x64-binaries.zip` | EDB binaries zip (~300MB), top folder `pgsql` (works, confirmed) |
| Adminer | `adminer-5.5.1.php` | single PHP file |
| phpMyAdmin | `phpMyAdmin-5.2.3-all-languages.zip` | |

VC++ Redistributable is downloaded from `https://aka.ms/vc14/vc_redist.x64.exe` and installed silently (UAC) if
`HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` `Installed` != 1.

## 4. File structure (project root `I:\my-laragon`)
```
main.js       Electron main process: ALL logic (download, services, DBs, vhosts, PHP versions, IPC)
preload.js    contextBridge: window.api.* (ipcRenderer.invoke wrappers)
index.html    UI shell (sidebar, pages: Services / Sites / Tools & Versions / Settings), CSS
renderer.js   UI logic (renders DB cards, sites table with PHP dropdown, tools page, language switch)
i18n.js       UI dictionary: I18N = { bn:{...}, en:{...} }, global LANG and t(key, ...args)
package.json
```
Runtime data (not in repo), under ROOT (default `%APPDATA%\my-laragon\`, user can move it in Settings):
- `tools\` — `Apache24\`, `nginx\`, `php\`, `php-<version>\` (added versions), `mysql\`, `mysql-<version>\`, `pgsql\`, `phpmyadmin\`, `adminer\`
- `data\mysql\`, `data\postgres\`, `data\my.ini` (default versions); other versions use `data\mysql-<ver>`, `data\postgres-<ver>`, `data\my-<ver>.ini`
- `data\php-tmp\{sessions,upload}` — PHP session/upload temp dirs (see lessons)
- `settings.json` (always in the default userData folder) — keys: `rootDir`, `wwwDir`, `webPort`, `mysqlPort`, `postgresPort`, `autoStart`, `pmaSecret`, `phpWorkers` (optional, default 4), `phpExt = { '<phpVersion>': { '<ext>': true|false } }`, `siteSession = { '<domain>': <minutes> }`,
  `toolVersions[id] = { active, items: { '<ver>': { folder, url, added } } }`, `sitePhp = { '<domain>': '<phpVersion>' }`, `lang` (`'bn'|'en'`)

## 5. What is implemented (main.js architecture)
- `makeService(id,label,url,folder,exeRel,opts)` + `SERVICES` = { php, mysql, postgres, phpmyadmin, apache, nginx }. dir/exe/url are **getters** that follow the active version and ROOT.
  `installInto(svc, destDir, {url|zipFile})`: download to `.part` then rename -> extract (Windows `tar.exe` first, `extract-zip` with 10-min timeout as fallback) into `_tmp_<name>` -> pick root or first top folder -> validate `exeRel` exists -> move to `tools\<folder>` -> `afterExtract`.
- **Web servers** (one at a time, shared web port; `busy` flag blocks parallel work). `startWebServer(id)` / `stopWebServer()`; `killStale` kills leftovers only inside our tools dir; `spawnChecked` (must survive 1.5 s); `isPortFree` check.
  - **Nginx + PHP**: `conf\nginx.conf` regenerated on every start/refresh. **Several** `php-cgi.exe -b 127.0.0.1:<random free port>` workers per **PHP version actually used** (`startPhpCgis`, default 4, `settings.phpWorkers` 1–16, started in parallel). `phpPorts` is `version -> [ports]`. `writeNginxConf` emits one `upstream php_<slug> { server 127.0.0.1:<port> max_fails=0; ... }` per version (round-robin) and each `server` block does `fastcgi_pass php_<slug>;` for its site's version. This stops loopback requests (wp-cron, REST/health checks) from hanging on a single busy php-cgi.
  - **Apache + PHP**: PHP runs as CGI (mod_cgi + mod_actions): `conf\server360.conf` (written each start, `Include`d from `httpd.conf` between `# server360 begin/end`) loads needed modules itself (`<IfModule !x>LoadModule…`), defines one `ScriptAlias /server360-php-<slug>/` per used PHP version, and each `<VirtualHost>` sets `SetEnv PHPRC` + `Action application/x-httpd-php "/server360-php-<slug>/php-cgi.exe"`. Reload = `httpd -k restart`.
  - `beforeStart(svc, phpPorts, sites, webPort)`; `running = { id, procs, phpPorts (version -> [ports]), webPort }`; `reloadRunning(sites)` applies new sites/PHP versions to a running server (starts missing php-cgi for Nginx, rewrites conf, reloads).
- **Virtual hosts**: every subfolder of www = `<name>.test` (lowercase, spaces→`-`, `[a-z0-9-]` only; `public\` subfolder becomes root for Laravel). hosts file managed block `# my-laragon begin/end`, edited via elevated PowerShell (UAC only when something changed). Works on both Nginx and Apache.
- **Adminer** (`adminer.test`, `localhost/adminer`) and **phpMyAdmin** (`phpmyadmin.test`, `localhost/phpmyadmin`): downloaded on first web-server start, local-machine only (`allow 127.0.0.1` / `Require local`). Adminer wrapper `index.php` auto-allows empty-password login; phpMyAdmin `config.inc.php` uses `auth_type=config`, root, empty password, MySQL port from settings. A www folder with the same name wins over the alias.
- **New site creator** (Sites page, IPC `site:create(kind,name)`, kind `blank`|`wordpress`): name sanitized like vhost names (`siteSlug`), refuses if the folder exists. `blank` writes a small `index.php`. `wordpress` needs MySQL running: downloads `https://wordpress.org/latest.zip` once into `ROOT\data\cache\wordpress-latest.zip` (cached; deleted if extraction fails), extracts with `extractZipSafe`, copies to `www\<name>`, creates DB `<name with - -> _>` via `bin\mysql.exe` (root, empty, MySQL port), writes `wp-config.php` from the sample (DB_HOST `127.0.0.1:<port>`, random salts). On failure the half-made folder is removed. Then sites are rescanned, hosts synced, running server reloaded, and the site opens in the browser if a web server is running. Laravel (Composer) is **not** done yet.
- **Per-site session lifetime** (Sites page, extra column, IPC `site:setSession(domain, minutes)`; empty/0 = PHP default): `settings.siteSession`. **php-cgi ignores `PHP_VALUE`** (that is php-fpm only; the first attempt with `fastcgi_param PHP_VALUE` only showed up in `$_SERVER`, Local Value stayed 1440 — user's phpinfo proved it). Current design: every `php.ini` gets `auto_prepend_file = ROOT\data\php-prepend\server360.php` (`ensureSitePrepend`, called from `enableExtensions`); the web server passes the site's seconds as `S360_SESSION` (Nginx `fastcgi_param S360_SESSION <s>;`, Apache `SetEnv S360_SESSION <s>` in the VirtualHost) and the script does `ini_set` for `session.gc_maxlifetime`, `session.cookie_lifetime` and a per-site `session.save_path` (`data\php-tmp\sessions\<server_name>`, so another site's GC cannot delete longer-lived sessions). Applied via `reloadRunning` for the server config, but the php.ini change needs one full web-server stop/start the first time. Limits: a site/app that sets its own `auto_prepend_file`, or calls `session_set_cookie_params()` / `ini_set()` itself, overrides this; Laravel uses its own `SESSION_LIFETIME` in `.env`, so the Laravel installer should write the site's minutes there.
- **PHP extensions per PHP version** (Tools & Versions page, card under the tool list, IPC `ext:list(version)` / `ext:set(version,name,on)`): lists every `ext\php_*.dll` of the chosen version (oci8/pdo_oci/pdo_firebird hidden), checkbox = enabled in that version's `php.ini`. Choices are stored in `settings.phpExt` and re-applied on every start by `applyExtOverrides` (called from `refreshPhpIni` after `enableExtensions`): it removes all lines of that extension and appends one clean `extension=<name>` (or `zend_extension=opcache`) when on. Changes need a web server stop/start (running php-cgi workers do not reload). Extensions are **per PHP version, not per site** on purpose (per-site would need separate worker pools = more RAM; decided with the user).
- **Per-site PHP version**: `settings.sitePhp`. Helpers: `phpVersionList()`, `phpDirOf(v)`, `pinnedPhp(domain)`, `sitePhpVersion(domain)`, `phpOfSite(site)` (system/tool sites always use default PHP), `neededPhpVersions(sites)`, `defaultPhpVersion()`. Missing/removed version falls back to the default. UI: dropdown per site in the Sites table (IPC `php:list`, `site:setPhp`).
- **Tools & Versions page**: for PHP, Nginx, Apache, MySQL, PostgreSQL, phpMyAdmin — add a version from an https ZIP link or a local ZIP, "Use" switches the active version (server must be stopped), "Remove" deletes non-active added versions (PHP removal needs the web server stopped and moves affected sites back to default). DB versions get separate data dirs so old databases are not corrupted (user must Export/Import to move data). Adminer versioning is **not** implemented.
- **php.ini** (`enableExtensions`, re-applied on every start for every used version): extensions mbstring, openssl, curl, mysqli, pdo_mysql, pgsql, pdo_pgsql, fileinfo, gd, zip, intl; timezone Asia/Dhaka; upload/post 128M; **`session.save_path`, `upload_tmp_dir`, `sys_temp_dir` -> `ROOT\data\php-tmp\…`**.
- **Databases** (generic `DATABASES` table: `prepare, isInitialized, init, spawnArgs, check, shutdownCmd`, `info` is a getter): MySQL 8.4 (`--initialize-insecure`, root/empty, port 3306) and PostgreSQL 18 (`initdb -A trust`, user `postgres`/empty, port 5432). Start waits until the DB answers (90 s); stop = graceful then force; app quit shuts them down gracefully. Adding a DB = service entry + `DATABASES` entry (+ release zip).
- **Start All / Stop All**: selected web server + DBs whose "Include in Start All" switch is on (MySQL default on, PostgreSQL default off).
- **Ports**: web port (default 80) and per-DB ports; validated, no duplicates, cannot change while running.
- **Folders**: first-run async dialogs ask for install folder (ROOT) and www folder; both changeable in Settings (`moveRoot` copies tools+data then deletes old).
- **i18n (Bangla + English)**: UI strings live in `i18n.js` (`t(key,…)`, `data-i18n` / `data-i18n-html` attributes in `index.html`, language stored in `localStorage('lang')` and pushed to main via `lang:set`). **Every user-facing string in `main.js` goes through `tr(bn, en)`** (reads `settings.lang`); `DATABASES[*].info` and `TOOL_HINT` are lazy so they follow the language. When adding a feature, add both languages (new UI keys in both `bn` and `en` of `i18n.js`; new main.js messages as `tr('বাংলা', 'English')`). Switching language re-renders DB cards, sites and tools.
- IPC channels: `service:start/stop`, `web:status`, `all:start/stop`, `db:list/start/stop/setAuto`, `port:get/set`, `sites:list/refresh`, `site:setPhp`, `site:create`, `site:setSession`, `ext:list/set`, `php:list`, `www:get/choose/open`, `root:get/choose/open`, `adminer:open`, `pma:open`, `tools:list/add/use/remove/help`, `lang:get/set`, `open:url` (only localhost / *.test); events `status`, `www:changed`, `root:changed`.

## 6. Verification status (be honest about this)
Confirmed working **by the user on Windows** (screenshots / messages): app launches with the new "Server 360" UI; Apache and Nginx start; Nginx + PHP; virtual hosts (`blog.test`); www/install folder pickers; MySQL starts; PostgreSQL download/extract/initdb/start (after the tar.exe fix); Start All; Adminer and phpMyAdmin pages open; the phpMyAdmin session error was fixed (the user reported it solved); the user reviewed the per-site PHP column and the Bangla/English UI and said it looks good.

Also confirmed by the user (2026-11-09): **WordPress one-click creator works on Windows** (site `test.test`, DB `test` created, WordPress install finished, `wp-admin` dashboard opened, WordPress 7.1.4; the status bar showed "test.test created. Database: test (root, empty password)"; the new English card looks fine); per-site PHP with two real PHP versions works, and the multi-worker php-cgi + Nginx `upstream` change works (8 `php-cgi.exe` seen, `phpinfo()` per site correct, switching a site's PHP version + Refresh sites without stopping the server works).

**Not explicitly confirmed on the user's PC (tested only with fake binaries on Linux):**
- **Session lifetime + PHP extensions** (written 2026-11-09): session lifetime v1 (`PHP_VALUE`) FAILED on the user's PC (see above); v2 (`auto_prepend_file`) is only syntax-checked/stub-tested on Linux. Check after one full server restart: for a site with 1 minute, `ini_get('session.gc_maxlifetime')` = 60 and `phpinfo()` Local Value 60 (Master stays 1440); another site stays 1440/0; Apache too; clearing the field returns to default. Extensions: toggle e.g. `exif`, restart, check `phpinfo()`; Bangla/English layout of the Session column and extension card.
- **New site creator, remaining checks:** the **blank site** button; WordPress with MySQL **stopped** (expect a clear error and no leftover folder); duplicate name refused; the new card in the Bangla UI.
- Apache `-k restart` from "Refresh sites" on Windows console Apache (fallback: Stop + Start).
- Adding/using/removing a second version of MySQL/PostgreSQL/Nginx/Apache from the Tools page.
- Changing ROOT folder with real data; English UI layout (long English texts) on real screens.
- First-run dialogs are shown in Bangla because the language is not chosen yet.

## 7. Lessons / gotchas already hit (don't repeat)
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
- Do not rename `package.json` name / hosts markers / data folder (see section 1).

## 8. TODO / next steps — recommended order and why
1. **(quick) Ask the user to run the remaining checks in section 6** (especially the new multi-worker Nginx check) and fix whatever shows up. Done so far: per-site PHP with two real versions. Multi-worker php-cgi (formerly item 2) is implemented, awaiting the user's test.
2. **Quick app installer, remaining part: Laravel.** Blank site and WordPress are implemented; WordPress is confirmed working by the user. **Before Laravel (user's request, now done):** per-site session time and per-version extension switches exist; the Laravel installer should write `SESSION_LIFETIME` from the site's session minutes and make sure required extensions (mbstring, openssl, pdo_mysql, fileinfo, curl, zip, gd/intl recommended) are on. Laravel needs Composer (`composer.phar` run with the site's PHP, `composer create-project laravel/laravel`) and network access; also create its DB and write `.env`. Possible extras: choose PHP version at creation, optional WordPress admin auto-install.
3. **Small user-visible features** (pick by user request): MySQL root password setting, HTTPS for `*.test` (local certificate, needs elevation), tray icon, auto-start with Windows, log viewer / Apache-Nginx config editor, Adminer version management.
4. **More databases** — ask which: MariaDB, MongoDB, Redis. Add via the `DATABASES` table (+ Release zip + a Tools page entry).
5. **Windows installer** (`electron-builder`, NSIS, app icon, version number). Do it after features settle; installer-time questions (folders, language) can replace the first-run dialogs.
6. **Multiple DB versions running at the same time on different ports** (per-site DB choice is just the site's `.env`). Largest change; only if the user really needs it.
7. **Housekeeping, any time:** `npm audit`, move download URLs from constants to a small manifest/config, keep this file updated, commit/push regularly.
