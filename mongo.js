'use strict';
// R2 ধাপ ১: MongoDB-র জন্য ছোট সাহায্যকারী। কোনো নতুন package নয়।
// mongod.exe-র সাথে mongosh আসে না, আর Windows-এ `mongod --shutdown` চলে না। তাই নিরাপদে বন্ধ করতে
// আমরা নিজেই MongoDB-র OP_MSG প্রোটোকলে { shutdown: 1 } কমান্ড পাঠাই (শুধু 127.0.0.1-এ, পাসওয়ার্ড ছাড়া চালু থাকলে কাজ করে)।
// সফল হলে mongod সংযোগ কেটে দিয়ে নিজে বন্ধ হয়; ব্যর্থ হলে main.js কিছুক্ষণ পর প্রসেস মেরে দেয়।
// R2 ধাপ ২ (restore): একই পথে ডাটাবেসের তালিকা (listDatabases) আর ডাটাবেস মোছা (dropDatabase); উত্তর পড়ার জন্য ছোট BSON পাঠক।
const net = require('net');

// তিন ধরনের মান লাগে: int32, string ও bool
function bsonDoc(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    const key = Buffer.from(k + '\0', 'utf8');
    if (typeof v === 'boolean') {
      const b = Buffer.alloc(1 + key.length + 1);
      b[0] = 0x08;
      key.copy(b, 1);
      b[1 + key.length] = v ? 1 : 0;
      parts.push(b);
    } else if (typeof v === 'number') {
      const b = Buffer.alloc(1 + key.length + 4);
      b[0] = 0x10;
      key.copy(b, 1);
      b.writeInt32LE(v, 1 + key.length);
      parts.push(b);
    } else {
      const s = Buffer.from(String(v) + '\0', 'utf8');
      const b = Buffer.alloc(1 + key.length + 4 + s.length);
      b[0] = 0x02;
      key.copy(b, 1);
      b.writeInt32LE(s.length, 1 + key.length);
      s.copy(b, 1 + key.length + 4);
      parts.push(b);
    }
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(4 + body.length + 1);
  out.writeInt32LE(out.length, 0);
  body.copy(out, 4);
  return out; // শেষ বাইট 0 (Buffer.alloc-এ আগেই শূন্য)
}

// OP_MSG (opCode 2013): header(16) + flagBits(4) + section kind 0 + BSON
function opMsg(fields, requestId = 1) {
  const doc = bsonDoc(fields);
  const b = Buffer.alloc(16 + 4 + 1 + doc.length);
  b.writeInt32LE(b.length, 0);
  b.writeInt32LE(requestId, 4);
  b.writeInt32LE(0, 8);
  b.writeInt32LE(2013, 12);
  b.writeUInt32LE(0, 16);
  b[20] = 0;
  doc.copy(b, 21);
  return b;
}

// mongod-কে shutdown বলা। ফেরত: true = সংযোগ কেটে গেছে বা উত্তর এসেছে (বন্ধ হচ্ছে), false = পাঠানো যায়নি
function shutdown(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => sock.write(opMsg({ shutdown: 1, $db: 'admin' })));
    sock.on('data', () => {}); // উত্তর পড়ার দরকার নেই (হয় ok, নয়তো সংযোগ কাটে)
    sock.once('close', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// ছোট BSON পাঠক: উত্তরের নথি পড়ে JS অবজেক্ট/অ্যারে বানায়। না-চেনা ধরন পেলে ওই নথির পড়া থামে (যা পড়া হয়েছে তা থাকে)।
function readBson(buf, start = 0) {
  const size = buf.readInt32LE(start);
  const end = start + size;
  if (size < 5 || end > buf.length) throw new Error('bad BSON size');
  const out = {};
  let i = start + 4;
  while (i < end - 1) {
    const type = buf[i++];
    let j = i;
    while (j < end && buf[j] !== 0) j++;
    const key = buf.toString('utf8', i, j);
    i = j + 1;
    let val;
    switch (type) {
      case 0x01:
        val = buf.readDoubleLE(i);
        i += 8;
        break;
      case 0x02: {
        const n = buf.readInt32LE(i);
        val = buf.toString('utf8', i + 4, i + 4 + n - 1);
        i += 4 + n;
        break;
      }
      case 0x03:
      case 0x04: {
        const n = buf.readInt32LE(i);
        const sub = readBson(buf, i);
        val = type === 0x04 ? Object.keys(sub).map((k) => sub[k]) : sub;
        i += n;
        break;
      }
      case 0x05:
        i += 4 + 1 + buf.readInt32LE(i);
        val = null;
        break;
      case 0x07:
        i += 12;
        val = null;
        break;
      case 0x08:
        val = buf[i] === 1;
        i += 1;
        break;
      case 0x09:
      case 0x11:
      case 0x12:
        i += 8;
        val = null;
        break;
      case 0x0a:
        val = null;
        break;
      case 0x10:
        val = buf.readInt32LE(i);
        i += 4;
        break;
      case 0x13:
        i += 16;
        val = null;
        break;
      default:
        return out; // না-চেনা ধরন
    }
    out[key] = val;
  }
  return out;
}

// OP_MSG উত্তর থেকে প্রথম নথি (section kind 0)
function parseReply(buf) {
  if (buf.length < 26) throw new Error('short reply');
  const flags = buf.readUInt32LE(16);
  if (buf[20] !== 0) throw new Error('unexpected section');
  const doc = readBson(buf, 21);
  void flags;
  return doc;
}

// একটা কমান্ড পাঠিয়ে উত্তরের নথি ফেরত। ফেরত: { ok, doc } বা { ok:false, message }। শুধু 127.0.0.1।
function command(port, fields, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    let got = Buffer.alloc(0);
    let sock;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    sock.setTimeout(timeoutMs, () => finish({ ok: false, message: 'timed out' }));
    sock.once('connect', () => sock.write(opMsg(fields)));
    sock.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 4 && got.length >= got.readInt32LE(0)) {
        try {
          const doc = parseReply(got.subarray(0, got.readInt32LE(0)));
          finish({ ok: true, doc });
        } catch (e) {
          finish({ ok: false, message: e.message });
        }
      }
    });
    sock.once('close', () => finish({ ok: false, message: 'connection closed' }));
    sock.once('error', (e) => finish({ ok: false, message: e.message }));
  });
}

// এখন কোন কোন ডাটাবেস আছে। ফেরত: { ok:true, dbs:[নাম] } বা { ok:false, message }
async function listDatabases(port) {
  const r = await command(port, { listDatabases: 1, nameOnly: true, $db: 'admin' });
  if (!r.ok) return r;
  if (r.doc.ok !== 1 || !Array.isArray(r.doc.databases)) return { ok: false, message: String(r.doc.errmsg || 'unexpected reply') };
  return { ok: true, dbs: r.doc.databases.map((d) => String((d && d.name) || '')).filter(Boolean) };
}

// একটা ডাটাবেস মুছে ফেলা (restore-এর overwrite-এ, safety dump সফল হওয়ার পর)
async function dropDatabase(port, name) {
  const r = await command(port, { dropDatabase: 1, $db: String(name) }, 120000);
  if (!r.ok) return r;
  if (r.doc.ok !== 1) return { ok: false, message: String(r.doc.errmsg || 'dropDatabase failed') };
  return { ok: true };
}

module.exports = { shutdown, opMsg, bsonDoc, command, listDatabases, dropDatabase, readBson };
