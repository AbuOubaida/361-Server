'use strict';
// R2 ধাপ ১: MongoDB-র জন্য ছোট সাহায্যকারী। কোনো নতুন package নয়।
// mongod.exe-র সাথে mongosh আসে না, আর Windows-এ `mongod --shutdown` চলে না। তাই নিরাপদে বন্ধ করতে
// আমরা নিজেই MongoDB-র OP_MSG প্রোটোকলে { shutdown: 1 } কমান্ড পাঠাই (শুধু 127.0.0.1-এ, পাসওয়ার্ড ছাড়া চালু থাকলে কাজ করে)।
// সফল হলে mongod সংযোগ কেটে দিয়ে নিজে বন্ধ হয়; ব্যর্থ হলে main.js কিছুক্ষণ পর প্রসেস মেরে দেয়।
const net = require('net');

// মাত্র দুটো ধরনের মান লাগে: int32 ও string
function bsonDoc(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    const key = Buffer.from(k + '\0', 'utf8');
    if (typeof v === 'number') {
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

module.exports = { shutdown, opMsg, bsonDoc };
