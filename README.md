# 361-Server (Server 360)

Local development environment for Windows (Apache/Nginx, PHP, MySQL, PostgreSQL, MongoDB, Node sites, backup/restore, monitoring).

## Run from source

Requirements:

- Windows
- **Node.js 22.12 or newer** (Node 24 LTS is recommended). Check with `node -v`. An older Node makes `npm install` / `npm start` fail with Electron errors; a check script prints a clear message in that case.
  - Several Node versions on one PC: use [nvm-windows](https://github.com/coreybutler/nvm-windows), then `nvm install 24` and `nvm use 24`.
- Git

```
git clone <repo-url>
cd 361-Server
npm install
npm start
```

The app itself runs on the Node that is built into Electron. Your system Node is only used by `npm install` and `npm start`.
Node sites inside the app use their own downloaded Node (managed on the Tools page).

## Notes

- Tools (web server, PHP, databases, 7-Zip ...) are downloaded by the app on first use, so the first start needs internet.
- If you must skip the Node check (not recommended): set `S360_SKIP_NODE_CHECK=1`.
