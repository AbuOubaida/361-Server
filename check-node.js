'use strict';
// Server 360: Node version check. Runs before `npm install` and `npm start` (see "scripts" in package.json).
// Written in old-style JavaScript on purpose, so it can run even on a very old Node and still print a clear message.
// To skip the check (not recommended): set the environment variable S360_SKIP_NODE_CHECK=1
var MIN = [22, 12, 0];
var raw = String(process.versions && process.versions.node || '0.0.0');
var cur = raw.split('.').map(function (x) { return parseInt(x, 10) || 0; });

function older(a, b) {
  for (var i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

if (process.env.S360_SKIP_NODE_CHECK === '1') process.exit(0);

if (older(cur, MIN)) {
  var need = MIN.join('.');
  console.error('');
  console.error('==============================================================');
  console.error(' Server 360: your Node.js is too old (' + raw + '). Node ' + need + ' or newer is needed.');
  console.error(' Electron 45 and its install tools require it, so npm install / npm start would fail.');
  console.error('');
  console.error(' What to do:');
  console.error('   1. Install Node.js 24 (LTS) or 22.12+ from https://nodejs.org');
  console.error('      (or with nvm-windows: nvm install 24  then  nvm use 24)');
  console.error('   2. Close this terminal, open a new one, check:  node -v');
  console.error('   3. Run the command again.');
  console.error('');
  console.error(' Server 360: apnar Node.js onek purono (' + raw + '). Node ' + need + ' ba tar cheye notun lagbe.');
  console.error(' nodejs.org theke Node 24 (LTS) install korun, notun terminal khule  node -v  diye dekhun, tarpor abar chalan.');
  console.error('==============================================================');
  console.error('');
  process.exit(1);
}
