// «طلبك جاهز» — نموذج إثبات عملي
// خادم واحد بلا قاعدة بيانات: صفحة كاشير، صفحة عميل، بث صوتي حي، Web Push، و APNs اختياري للـ App Clip.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 3000);
// العنوان العام: من المتغير PUBLIC_URL إن وجد، أو من النفق الذي يفتحه start.js، أو من ترويسات الطلب نفسه
let PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
function setPublicUrl(u) { PUBLIC_URL = String(u).replace(/\/$/, ''); }
function baseOf(req) {
  if (process.env.PUBLIC_URL || global.__TUNNEL_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
const CAFE_NAME = process.env.CAFE_NAME || 'مقهى التجربة';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // على Render يمكن ربطه بقرص دائم
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- VAPID (Web Push) ----------
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
// مفاتيح ثابتة لا تتغير عند إعادة تشغيل السيرفر، حتى لا تنقطع اشتراكات جوالات العملاء
if (process.env.VAPID_SEED) {
  const ecdh = require('crypto').createECDH('prime256v1');
  ecdh.setPrivateKey(require('crypto').createHash('sha256').update(process.env.VAPID_SEED).digest());
  vapid = { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
} else if (fs.existsSync(vapidFile)) vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
else { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid)); }
webpush.setVapidDetails('mailto:poc@example.com', vapid.publicKey, vapid.privateKey);

// ---------- MP3 frames ----------
// نقسم ملفات MP3 إلى إطارات مستقلة حتى نبث بإيقاع الزمن الحقيقي وندرج النغمة في اللحظة المطلوبة.
const BITRATES = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function parseMp3Frames(buf) {
  const frames = []; let i = 0, frameSec = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3;
    const bri = buf[i + 2] >> 4, sri = (buf[i + 2] >> 2) & 3, pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const br = BITRATES[ver === 3 ? 1 : 2][bri] * 1000, sr = RATES[ver][sri];
    const spf = ver === 3 ? 1152 : 576;
    const len = Math.floor((spf / 8) * br / sr) + pad;
    if (i + len > buf.length) break;
    frames.push(buf.subarray(i, i + len)); frameSec = spf / sr; i += len;
  }
  return { frames, frameSec };
}
const chime = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets/chime.mp3')));
const testTone = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets/test_tone.mp3')));   // نغمة تجربة قصيرة تختلف عن نغمة الجاهزية
const silence = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets', process.env.SILENCE_FILE || 'silence_64.mp3')));
// صمت بمعدل بت مرتفع للدفعة الأولى فقط: المتصفحات تنتظر عددا من البايتات (نحو 32 كيلوبايت في Chromium) قبل بدء التشغيل،
// فنملأ هذا الحد بأقصر مدة زمنية ممكنة حتى لا يتأخر التنبيه بعدها
const silenceHi = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets/silence_hi.mp3')));
const FRAME_SEC = silence.frameSec;
const PREBUFFER_SEC = Number(process.env.PREBUFFER_SEC || 0.5);
const BURST_BYTES = Number(process.env.BURST_BYTES || 40000);             // دفعة أولى صغيرة ليبدأ التشغيل، ثم إيقاع حقيقي حتى لا يخزن الجهاز مسبقا
const CHIME_REPEAT_EVERY_SEC = 6;      // تكرار النغمة حتى يؤكد العميل أو تنتهي المهلة
const CHIME_MAX_SEC = 180;
const STREAM_MAX_MIN = Number(process.env.STREAM_MAX_MIN || 60);

// ---------- State ----------
const orders = new Map();              // id -> order
let nextNumber = 101;
const now = () => Date.now();
const DAY_START_HOUR = Number(process.env.DAY_START_HOUR ?? 4);   // يبدأ يوم الترقيم الساعة 4 فجرا بتوقيت الرياض حتى لا يتصفر وسط الوردية الليلية
const riyadhDay = t => new Date(t + (3 - DAY_START_HOUR) * 3600e3).toISOString().slice(0, 10);
// حفظ الطلبات على القرص حتى لا تضيع عند إعادة تشغيل الخادم
const ordersFile = path.join(DATA_DIR, 'orders.json');
function writeAtomic(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
let saveOT = null;
function saveOrders() { clearTimeout(saveOT); saveOT = setTimeout(() => { try {
  const keep = [...orders.values()].filter(o => now() - o.createdAt < 12 * 3600e3)
    .map(o => ({ ...o, devices: [...o.devices], clients: [...(o.clients || [])], acks: [...(o.acks || [])], streams: undefined, repeatTimer: undefined, events: o.events.slice(-60) }));
  writeAtomic(ordersFile, JSON.stringify({ nextNumber, day: riyadhDay(now()), orders: keep }));
} catch (e) { console.error('saveOrders', e.message); } }, 500); }
function loadOrders() { try {
  const d = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
  if (d.day === riyadhDay(now())) nextNumber = d.nextNumber || 101;
  for (const o of d.orders || []) { o.devices = new Set(o.devices || []); o.clients = new Set(o.clients || []); o.acks = new Set(o.acks || []); o.streams = new Set(); orders.set(o.id, o); }
  console.log(`استرجعت ${orders.size} طلبا محفوظا`);
} catch {} }
let numberDay = riyadhDay(now());
function newOrder(number, source = 'cashier', meta = {}) {
  if (riyadhDay(now()) !== numberDay) { numberDay = riyadhDay(now()); nextNumber = 101; }
  const id = crypto.randomBytes(8).toString('hex');
  const o = { id, number: String(number ?? nextNumber++), status: 'waiting', source, meta, createdAt: now(), readyAt: null, ackAt: null, pickedAt: null,
    phone: normPhone(meta.phone), devices: new Set(), clients: new Set(), acks: new Set(), push: [], apns: [], streams: new Set(), events: [] };
  try { o.eta = estimatePrep(o); } catch {}
  orders.set(id, o); log(o, 'created', { source, phone: o.phone ? '***' + o.phone.slice(-4) : undefined }); saveOrders(); return o;
}
// ---------- Devices (جوالات مسجلة مرة واحدة: تطبيق الشاشة الرئيسية) ----------
const devicesFile = path.join(DATA_DIR, 'devices.json');
const devices = new Map();             // id -> { id, subs:[], phone, ua, createdAt, lastSeen, lastTest, log:[] }
try { for (const d of JSON.parse(fs.readFileSync(devicesFile, 'utf8'))) devices.set(d.id, d); } catch {}
let saveT = null;
function saveDevices() { clearTimeout(saveT); saveT = setTimeout(() => { try { writeAtomic(devicesFile, JSON.stringify([...devices.values()])); } catch (e) { console.error(e); } }, 300); }
function normPhone(v) { let d = String(v || '').replace(/\D/g, ''); if (!d) return ''; d = d.replace(/^00/, '').replace(/^966/, '').replace(/^0/, ''); return d.slice(-9); }
function devLog(d, type, data = {}) { d.log = d.log || []; d.log.push({ t: now(), type, ...data }); if (d.log.length > 40) d.log.shift(); saveDevices(); }
function devicesForOrder(o) {
  const out = [];
  for (const d of devices.values()) {
    if (!d.subs || !d.subs.length) continue;
    // الربط برقم الجوال لا يفعل إلا بعد أن يثبت الجهاز الرقم مرة واحدة بفتح طلب مسجل بالرقم نفسه (حتى لا يستقبل غريب إشعارات رقم ليس له)
    if ((o.phone && d.phone === o.phone && d.phoneVerified === o.phone) || (o.devices && o.devices.has(d.id))) out.push(d);
  }
  return out;
}
loadOrders();
// ===== سجل الاحداث الدائم (اساس التحليلات والتنبؤ) =====
// كل حدث يُكتب سطرا في ملف events-YYYY-MM.jsonl ولا يُحذف ابدا. لا يحتوي ارقام جوال ولا هويات عملاء، فقط ارقام الطلبات والازمنة والقناة ونوع الجهاز.
function osOf(ua) { ua = String(ua || ''); return /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : ua ? 'other' : ''; }
let evBuf = [], evT = null;
function flushEvents() { evT = null; if (!evBuf.length) return; const file = path.join(DATA_DIR, 'events-' + riyadhDay(now()).slice(0, 7) + '.jsonl'); const lines = evBuf.join(''); evBuf = []; try { fs.appendFileSync(file, lines); } catch (e) { console.error('events:', e.message); } }
function persistEvent(o, type, data) {
  const row = { t: now(), day: riyadhDay(now()), oid: o.id, n: o.number, type, status: o.status, src: o.source,
    sinceCreateSec: Math.round((now() - o.createdAt) / 1000), sinceReadySec: o.readyAt ? Math.round((now() - o.readyAt) / 1000) : null,
    os: osOf(data.ua || (o.meta && o.meta.ua)), clients: o.clients.size, devices: o.devices.size, streams: o.streams.size, table: o.table ? 1 : 0, items: (o.meta && o.meta.items) || undefined };
  for (const k of ['by', 'via', 'status', 'why', 'state', 'delayMs', 'n', 'apple', 'host', 'linked']) if (k in data && !(k in row)) row[k] = data[k];
  if ('status' in data) row.httpStatus = data.status;
  evBuf.push(JSON.stringify(row) + '\n'); if (!evT) evT = setTimeout(flushEvents, 1000);
}
process.on('exit', flushEvents); process.on('SIGTERM', () => { flushEvents(); process.exit(0); });
function log(o, type, data = {}) { o.events.push({ t: now(), type, ...data }); if (o.events.length > 200) o.events.shift(); persistEvent(o, type, data); sse(o); saveOrders(); }

// ===== احصائيات اولية من السجل الدائم (النسخة 1: متوسطات ونسب، بلا نماذج بعد) =====
function readEvents(months = 1) {
  const out = []; const d = new Date(now());
  for (let i = 0; i < months; i++) { const m = new Date(d.getFullYear(), d.getMonth() - i, 1); const f = path.join(DATA_DIR, `events-${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}.jsonl`);
    try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) try { out.push(JSON.parse(l)); } catch {} } catch {} }
  return out;
}
function pct(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function computeStats(days = 30) {
  const since = now() - days * 86400e3; const ev = readEvents(2).filter(e => e.t >= since);
  const byOrder = new Map(); for (const e of ev) { if (!byOrder.has(e.oid)) byOrder.set(e.oid, {}); const b = byOrder.get(e.oid); if (!(e.type in b)) b[e.type] = e; b._n = e.n; b._day = e.day; if (e.os && !b._os) b._os = e.os; }
  const prep = [], pickup = [], ackLag = [], hours = {}, daysMap = {}, osCount = { ios: 0, android: 0, other: 0, unknown: 0 };
  let created = 0, ready = 0, acked = 0, picked = 0, late = 0, chime = 0, push = 0, pushOk = 0;
  for (const b of byOrder.values()) {
    if (!b.created) continue; created++;
    const h = new Date(b.created.t + 3 * 3600e3).getUTCHours(); hours[h] = (hours[h] || 0) + 1; daysMap[b._day] = (daysMap[b._day] || 0) + 1;
    osCount[b._os || 'unknown']++;
    if (b.ready) { ready++; prep.push((b.ready.t - b.created.t) / 1000); }
    if (b.customer_ack && b.ready) { acked++; ackLag.push((b.customer_ack.t - b.ready.t) / 1000); }
    if (b.picked && b.ready) { picked++; const s = (b.picked.t - b.ready.t) / 1000; pickup.push(s); if (s > 300) late++; }
    if (b.chime_injected) chime++;
    if (b.webpush_sent) { push++; if (b.webpush_sent.httpStatus < 300) pushOk++; }
  }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, n]) => ({ hour: +h, orders: n }));
  return { days, orders: created, ready, picked, ackRate: ready ? +(acked / ready).toFixed(2) : null, pickedRate: ready ? +(picked / ready).toFixed(2) : null,
    prepSec: { median: pct(prep, 0.5), p80: pct(prep, 0.8), p95: pct(prep, 0.95) }, pickupSec: { median: pct(pickup, 0.5), p80: pct(pickup, 0.8), p95: pct(pickup, 0.95) },
    ackLagSec: { median: pct(ackLag, 0.5), p80: pct(ackLag, 0.8) }, lateOver5min: late, chimeDelivered: chime, pushSent: push, pushOk,
    os: osCount, peakHours: peak, perDay: daysMap, note: 'النسخة 1: مؤشرات وصفية. التنبؤ بوقت الجاهزية وكشف الطلب المنسي يُفعّلان بعد تجمع نحو 500 طلب.' };
}
// تقدير اولي لوقت الجاهزية لطلب جديد: الوسيط في نفس الساعة خلال 30 يوما، مع نطاق p80. يتطور الى نموذج تعلم الة بعد تجمع البيانات.
function estimatePrep(o) {
  const ev = readEvents(2); const since = now() - 30 * 86400e3; const h = new Date(now() + 3 * 3600e3).getUTCHours();
  const cr = new Map(), prep = [], prepH = [];
  for (const e of ev) { if (e.t < since) continue; if (e.type === 'created') cr.set(e.oid, e.t); if (e.type === 'ready' && cr.has(e.oid)) { const s = (e.t - cr.get(e.oid)) / 1000; prep.push(s); if (new Date(e.t + 3 * 3600e3).getUTCHours() === h) prepH.push(s); } }
  const src = prepH.length >= 20 ? prepH : prep; if (src.length < 10) return null;
  const open = [...orders.values()].filter(x => x.status === 'waiting').length;
  return { lowSec: Math.round(pct(src, 0.5)), highSec: Math.round(pct(src, 0.8)), basis: src.length, sameHour: src === prepH, openOrders: open };
}
function customerOrder(o) { return { id: o.id, number: o.number, status: o.status, table: o.table || '', eta: o.status === 'waiting' ? (o.eta || null) : null }; }
function readyAgeSec(o) { return o.readyAt ? Math.round((now() - o.readyAt) / 1000) : null; }
function boardOrder(o) { return { number: o.number, status: o.status, table: o.table || '', hot: !!(o.alert && o.alert.level === 2) }; }
function publicOrder(o) {
  const streams = [...o.streams].map(s => ({ ageSec: Math.round((now() - s.startedAt) / 1000), blocked: s.blocked,
    lastDrainAgoSec: Math.round((now() - s.lastFlowAt) / 1000), sentSec: Math.round(s.framesSent * FRAME_SEC), ua: s.ua }));
  return { id: o.id, number: o.number, status: o.status, createdAt: o.createdAt, readyAt: o.readyAt, ackAt: o.ackAt, pickedAt: o.pickedAt,
    phoneTail: o.phone ? o.phone.slice(-4) : '', linkedDevices: devicesForOrder(o).length, table: o.table || '', alert: o.alert || null,
    heard: !!o.heard, pushCount: o.push.length, pushApple: o.push.filter(x => String(x.endpoint).includes('push.apple.com')).length, apnsCount: o.apns.length, streams, events: o.events.slice(-12),
    reactionSec: o.readyAt && o.ackAt ? Math.round((o.ackAt - o.readyAt) / 100) / 10 : null, readyAgeSec: readyAgeSec(o), pickedAgeSec: o.pickedAt ? Math.round((now() - o.pickedAt) / 1000) : null,
    clients: (o.clients || new Set()).size, createdAgeSec: Math.round((now() - o.createdAt) / 1000), clientAudio: o.clientAudio || '' };
}

// ---------- Live audio stream ----------
// كل عميل فعّل التنبيه الصوتي يسحب بثا لا ينتهي: صمت شبه تام، وعند الجاهزية يحقن الخادم النغمة في البث نفسه.
// الهاتف لا يحتاج إلى تشغيل أي كود عند الجاهزية؛ مشغل الوسائط وحده يسحب البث ويشغل ما يصله.
const MAX_STREAMS_PER_ORDER = 3, MAX_STREAMS_TOTAL = Number(process.env.MAX_STREAMS || 2000);
let totalStreams = 0;
function startStream(o, req, res, key, wantTest) {
  for (const old of o.streams) if (old.key === key) { try { old.res.end(); } catch {} o.streams.delete(old); totalStreams--; }   // جهاز واحد يسحب بثا واحدا
  if (o.streams.size >= MAX_STREAMS_PER_ORDER || totalStreams >= MAX_STREAMS_TOTAL) return send(res, 429, '');
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store, no-transform', 'Accept-Ranges': 'none',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const s = { res, startedAt: now(), framesSent: 0, blocked: false, lastFlowAt: now(), ua: (req.headers['user-agent'] || '').slice(0, 80),
    queue: [], silenceIdx: 0, nextChimeAt: 0, testTone: !!wantTest, key };
  let acc = 0, k = 0; while (acc < BURST_BYTES) { const f = silenceHi.frames[k++ % silenceHi.frames.length]; s.queue.push(f); acc += f.length; }
  s.burstFrames = s.queue.length;
  o.streams.add(s); totalStreams++; log(o, 'stream_open', { ua: s.ua });
  res.on('drain', () => { s.blocked = false; s.lastFlowAt = now(); });
  const close = () => { if (o.streams.delete(s)) { totalStreams--; log(o, 'stream_closed', { afterSec: Math.round((now() - s.startedAt) / 1000) }); } };
  req.on('close', close); res.on('error', close);
}
function nextFrame(o, s) {
  if (s.queue.length) return s.queue.shift();
  const t = now();
  // نغمة تجريبية مرة واحدة عند البدء حتى يعرف العميل أن الصوت يعمل ويضبط مستواه
  if (s.testTone) { s.testTone = false; s.queue.push(...testTone.frames); return s.queue.shift(); }
  if (o.status === 'ready' && !o.acks.has(s.key) && t - o.readyAt < CHIME_MAX_SEC * 1000 && t >= s.nextChimeAt) {
    s.nextChimeAt = t + CHIME_REPEAT_EVERY_SEC * 1000;
    if (!s.chimeLogged) { s.chimeLogged = true; log(o, 'chime_injected', { delayMs: t - o.readyAt }); }
    s.queue.push(...chime.frames); return s.queue.shift();
  }
  const f = silence.frames[s.silenceIdx]; s.silenceIdx = (s.silenceIdx + 1) % silence.frames.length; return f;
}
setInterval(() => {
  const t = now();
  for (const o of orders.values()) for (const s of o.streams) {
    // إيقاف البث عند التسليم، أو بعد دقيقة من تأكيد العميل، أو بعد ساعة انتظار، لتوفير البيانات والبطارية
    const chimeOver = o.status === 'ready' && t - o.readyAt > (CHIME_MAX_SEC + 120) * 1000;
    if (o.status === 'picked' || (o.acks.has(s.key) && o.ackAt && t - o.ackAt > 60e3) || chimeOver || t - s.startedAt > STREAM_MAX_MIN * 60e3) { s.res.end(); o.streams.delete(s); totalStreams--; log(o, 'stream_stopped', { why: o.status === 'picked' ? 'picked' : chimeOver ? 'chime_window_over' : o.acks.has(s.key) ? 'acked' : 'timeout' }); continue; }
    const due = Math.floor(((t - s.startedAt) / 1000 + PREBUFFER_SEC) / FRAME_SEC) + s.burstFrames - s.framesSent;
    if (s.blocked || due <= 0) continue;
    const chunk = []; for (let k = 0; k < Math.min(due, 200); k++) chunk.push(nextFrame(o, s));
    s.framesSent += chunk.length;
    const ok = s.res.write(Buffer.concat(chunk));
    if (ok) s.lastFlowAt = t; else s.blocked = true;   // إذا توقف الجهاز عن القراءة نعرف ذلك هنا (ضغط عكسي من TCP)
  }
}, 50);

// ---------- Push channels ----------
const https = require('https');
const isApple = sub => /push\.apple\.com/.test(String(sub.endpoint));
// لا نرسل إلا إلى خدمات الإشعارات الرسمية (يمنع استغلال الخادم لطلب عناوين داخلية)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
function validSub(sub) { try { const u = new URL(sub.endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname)) && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'; } catch { return false; } }
const ALLOW_TEST_PUSH_HOSTS = !!process.env.ALLOW_TEST_PUSH_HOSTS;   // للاختبارات المحلية فقط
function sendRaw(details, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(details.endpoint); const headers = { ...details.headers }; if (contentType) headers['Content-Type'] = contentType;
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ statusCode: res.statusCode, body: b })); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout'))); req.end(details.body);
  });
}
// يبني الرسالتين: Declarative Web Push لأجهزة Apple (يعرضه النظام مباشرة مع الصوت والاهتزاز)، والرسالة التقليدية لعامل الخدمة في أندرويد
function buildPayload(sub, n, B) {
  if (isApple(sub)) return JSON.stringify({ web_push: 8030, notification: { title: n.title, lang: 'ar', dir: 'rtl', body: n.body, navigate: n.url, silent: false, app_badge: '1' } });
  return JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: n.url, dev: n.dev, image: `${B}/ready-banner.png`, icon: `${B}/icon-192.png`, badge: `${B}/badge.png` });
}
async function pushTo(sub, n, B = PUBLIC_URL) {
  const payload = buildPayload(sub, n, B);
  const r = await sendRaw(webpush.generateRequestDetails(sub, payload, { TTL: 600, urgency: 'high' }), isApple(sub) ? 'application/notification+json' : undefined);
  if (r.statusCode >= 400) throw Object.assign(new Error(r.body), { statusCode: r.statusCode, body: r.body });
  return r;
}
function readyTargets(o) {
  const seen = new Set(), out = [];
  for (const sub of o.push) if (!seen.has(sub.endpoint)) { seen.add(sub.endpoint); out.push({ sub }); }
  for (const d of devicesForOrder(o)) for (const sub of d.subs) if (!seen.has(sub.endpoint)) { seen.add(sub.endpoint); out.push({ sub, dev: d }); }
  return out;
}
async function notifyAll(o, repeat = false) {
  const targets = readyTargets(o);
  if (repeat && !targets.length) return;
  const B = o.base || PUBLIC_URL;
  for (const { sub, dev } of targets) {
    if (o.status !== 'ready') return;   // تراجع الموظف أثناء الإرسال
    // ايفون: كل تكرار إشعار مستقل (يكتفي بثلاثة)، أندرويد: نفس الوسم ليهتز من جديد دون تكديس
    if (repeat && isApple(sub) && (o.repeats || 0) >= 2) continue;
    const n = { title: `🔔 طلبك جاهز | رقم ${o.number}`, body: `تفضل بالاستلام من ${CAFE_NAME}`, tag: `order-${o.id}`, url: `${B}/o/${o.id}?app=1` };
    try { const r = await pushTo(sub, n, B); log(o, 'webpush_sent', { status: r.statusCode, via: dev ? 'device' : 'page', apple: isApple(sub) }); if (dev) devLog(dev, 'ready_sent', { order: o.number, status: r.statusCode }); }
    catch (e) { log(o, 'webpush_error', { status: e.statusCode, msg: (e.statusCode === 410 || e.statusCode === 404) ? 'الجوال ألغى الاشتراك (أُوقفت إشعارات الموقع من الجوال)' : String(e.body || e.message).slice(0, 120) }); if (dev) devLog(dev, 'ready_error', { status: e.statusCode });
      if (e.statusCode === 410 || e.statusCode === 404) o.push = o.push.filter(x => x.endpoint !== sub.endpoint);
      if (dev && (e.statusCode === 404 || e.statusCode === 410)) { dev.subs = dev.subs.filter(x => x.endpoint !== sub.endpoint); saveDevices(); } }
  }
  if (repeat) { o.repeats = (o.repeats || 0) + 1; return; }
  for (const tok of o.apns) {
    try { const st = await sendApns(tok, { aps: { alert: { title: CAFE_NAME, body: `طلبك رقم ${o.number} جاهز` }, sound: 'default', 'interruption-level': 'time-sensitive',
      'target-content-id': `${o.base || PUBLIC_URL}/o/${o.id}` } }); log(o, 'apns_sent', { status: st }); }
    catch (e) { log(o, 'apns_error', { msg: String(e.message).slice(0, 120) }); }
  }
}
// APNs (للـ App Clip) — يعمل فقط إذا وُضعت مفاتيح Apple في متغيرات البيئة. غير مختبر في هذه البيئة.
let apnsJwt = null;
function sendApns(token, body) {
  const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, APNS_HOST = 'api.push.apple.com' } = process.env;
  if (!APNS_KEY_PATH) return Promise.reject(new Error('APNs not configured'));
  if (!apnsJwt || now() - apnsJwt.at > 40 * 60 * 1000) {
    const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: APNS_KEY_ID })}.${b64({ iss: APNS_TEAM_ID, iat: Math.floor(now() / 1000) })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: fs.readFileSync(APNS_KEY_PATH), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    apnsJwt = { at: now(), token: `${unsigned}.${sig}` };
  }
  const http2 = require('http2');
  return new Promise((resolve, reject) => {
    const c = http2.connect(`https://${APNS_HOST}`); c.on('error', reject);
    const r = c.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsJwt.token}`, 'apns-topic': APNS_TOPIC,
      'apns-push-type': 'alert', 'apns-priority': '10' });
    r.on('response', h => { resolve(h[':status']); r.close(); c.close(); }); r.on('error', reject); r.end(JSON.stringify(body));
  });
}

// ---------- SSE for open pages ----------
const sseClients = new Map(); // id -> Set(res)
function sse(o) { const set = sseClients.get(o.id); if (!set) return; const d = `data: ${JSON.stringify({ status: o.status, number: o.number, eta: o.status === 'waiting' ? (o.eta || null) : null })}\n\n`; for (const r of set) r.write(d); }

// ---------- Actions ----------
// عند الجاهزية: إشعار فوري ثم تكرار كل 12 ثانية حتى يستجيب العميل أو تمر 3 دقائق، فيهتز الجوال مع كل تكرار (أندرويد)
function setReady(o, by) {
  if (o.status !== 'waiting') return; o.status = 'ready'; o.readyAt = now(); o.ackAt = null; o.acks = new Set(); log(o, 'ready', { by });
  o.alert = { shown: false, seen: false, level: 0, note: '' };
  notifyAll(o);
  clearInterval(o.repeatTimer);
  o.repeatTimer = setInterval(() => {
    if (o.status !== 'ready' || o.ackAt || now() - o.readyAt > 180e3 || !readyTargets(o).length) return clearInterval(o.repeatTimer);
    notifyAll(o, true);
  }, 12000);
}
// تراجع الموظف عن "جاهز" خلال 20 ثانية: يتوقف الرنين، ويصل العميل إشعار تصحيح
const UNDO_SEC = 20;
async function undoReady(o) {
  if (o.status !== 'ready' || now() - o.readyAt > UNDO_SEC * 1000) return false;
  clearInterval(o.repeatTimer); o.status = 'waiting'; o.readyAt = null; o.alert = null; o.ackAt = null; o.repeats = 0;
  for (const s of o.streams) { s.nextChimeAt = 0; s.chimeLogged = false; s.queue = []; }
  o.acks = new Set();
  log(o, 'ready_undone');
  const B = o.base || PUBLIC_URL;
  for (const { sub } of readyTargets(o)) {
    try { await pushTo(sub, { title: `تنبيه بالخطأ | طلب ${o.number}`, body: 'طلبك باقي قيد التحضير، وبنبهك أول ما يجهز', tag: `order-${o.id}`, url: `${B}/o/${o.id}` }, B); } catch {}
  }
  return true;
}
// الإشارات التي تؤكد أن العميل استلم التنبيه أو رآه
function markAlert(o, state) {
  if (/^audio_(paused|error|resume_failed|blocked)/.test(state)) o.clientAudio = 'down';
  else if (/^(audio_resumed|armed audio=true|visible playing|hidden playing)/.test(state)) o.clientAudio = 'up';
  if (!o.alert) return;
  if (state === 'sw_notification_shown') o.alert.shown = true;
  if (['ready_page_visible', 'ready_screen_seen'].includes(state) || state.startsWith('visible')) o.alert.seen = true;
}
function audioFlowing(o) { return o.clientAudio !== 'down' && [...o.streams].some(s => !s.blocked || now() - s.lastFlowAt < 8000); }
function evalAlert(o) {
  if (o.status !== 'ready' || !o.alert) return;
  const age = (now() - o.readyAt) / 1000, a = o.alert;
  if (o.ackAt || a.seen) { a.level = -1; a.note = 'العميل شاف التنبيه'; return; }
  const chan = [];
  if (audioFlowing(o)) chan.push('الجوال يستقبل نغمة الرنين');
  if (a.shown) chan.push('الإشعار ظهر على الجوال');
  else if (readyTargets(o).some(t => isApple(t.sub))) chan.push('أُرسل إشعار للايفون');
  const onlyUnconfirmed = chan.length === 1 && !a.shown && !audioFlowing(o);
  if (chan.length) { a.level = age > 60 || (onlyUnconfirmed && age > 20) ? 1 : 0; a.note = chan.join(' و') + (age > 60 ? '، لكنه لم يستجب بعد' : ''); return; }
  a.level = age > 15 ? 2 : 1; a.note = age > 15 ? 'لا يصل أي تنبيه للجوال. وجّهه لشاشة الطلبات أو الطاولة' : 'لم يتأكد وصول التنبيه بعد';
}
setInterval(() => { for (const o of orders.values()) evalAlert(o); }, 3000);
function setPicked(o) { if (o.status === 'picked') return; clearInterval(o.repeatTimer); o.prevStatus = o.status; o.status = 'picked'; o.pickedAt = now(); log(o, 'picked'); }
function undoPicked(o) { if (o.status !== 'picked' || now() - o.pickedAt > UNDO_SEC * 1000) return false; o.status = o.prevStatus || 'ready'; o.pickedAt = null; log(o, 'picked_undone'); return true; }

// ---------- Cashier auth ----------
// لوحة الكاشير وأوامرها خلف رمز سري لكل مقهى (CASHIER_PIN). الرمز الافتراضي للتجربة فقط وتظهر اللوحة تحذيرا بتغييره.
// إذا لم يضبط الرمز تبقى اللوحة مقفلة وتعرض طريقة ضبطه، ولا يوجد رمز افتراضي يمكن تخمينه من الكود المنشور
const CASHIER_PIN = String(process.env.CASHIER_PIN || '');
const PIN_IS_DEFAULT = !CASHIER_PIN;
const PIN_TOO_SHORT = !!CASHIER_PIN && CASHIER_PIN.length < 6;
const CASHIER_TOKEN = crypto.createHmac('sha256', vapid.privateKey).update('cashier:' + (CASHIER_PIN || crypto.randomBytes(16).toString('hex'))).digest('base64url');
let globalFails = { n: 0, at: 0 };
const loginFails = new Map();          // ip -> { n, at }
// Render يضيف عنوان العميل الحقيقي في آخر X-Forwarded-For، وما قبله قد يكتبه المهاجم
const TRUST_PROXY = !!(process.env.RENDER || process.env.TRUST_PROXY);   // Render يضبط المتغير RENDER تلقائيا
function clientIp(req) { const x = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean) : []; return x.length ? x[x.length - 1] : String(req.socket.remoteAddress || ''); }
function isCashier(req) { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)tj_c=([\w-]+)/); return !!m && m[1].length === CASHIER_TOKEN.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(CASHIER_TOKEN)); }
function sameStr(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---------- Customer tokens ----------
// كل جهاز يفتح صفحة الطلب يحصل على مفتاح خاص بهذا الطلب في كوكي، ولا تقبل أوامر العميل (التأكيد، الإشعارات، البث) بدونه
const MAX_CLIENTS_PER_ORDER = 3;
function clientKey(req, o) { const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)tj_o_' + o.id + '=([a-f0-9]{24})')); return m && o.clients.has(m[1]) ? m[1] : null; }

// ---------- HTTP ----------
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'" };
function send(res, code, body, type = 'text/html; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(type.startsWith('text/html') ? SEC_HEADERS : { 'X-Content-Type-Options': 'nosniff' }) }); res.end(body); }
function json(res, obj, code = 200) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req) { return new Promise(r => { let b = '', done = false; const fin = v => { if (!done) { done = true; r(v); } };
  req.on('data', c => { b += c; if (b.length > 16384) { fin({}); req.destroy(); } }); req.on('end', () => { try { fin(JSON.parse(b || '{}')); } catch { fin({}); } }); req.on('close', () => fin({})); }); }
const htmlEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (name, base = PUBLIC_URL, extra = {}) => Object.entries(extra).reduce((h, [k, v]) => h.replaceAll(`{{${k}}}`, htmlEsc(v)), fs.readFileSync(path.join(__dirname, 'public', name), 'utf8'))
  .replaceAll('{{CAFE}}', htmlEsc(CAFE_NAME)).replaceAll('{{VAPID}}', vapid.publicKey).replaceAll('{{BASE}}', base);

const server = http.createServer(async (req, res) => {
  const BASE = baseOf(req); const url = new URL(req.url, 'http://x'); const p = url.pathname; let m;
  try {
    if (p === '/health') return send(res, 200, 'ok v17', 'text/plain');
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req), f = loginFails.get(ip);
      if (!CASHIER_PIN) return json(res, { error: 'no_pin', msg: 'لم يضبط الرمز السري بعد. أضفه من إعدادات الخادم باسم CASHIER_PIN' }, 503);
      if (f && f.n >= 8 && now() - f.at < 15 * 60e3) return json(res, { error: 'locked', msg: 'محاولات كثيرة، حاول بعد ربع ساعة' }, 429);
      // إبطاء عام عند كثرة المحاولات الخاطئة من عناوين مختلفة
      if (now() - globalFails.at > 15 * 60e3) globalFails = { n: 0, at: now() };
      if (globalFails.n > 30) await new Promise(r => setTimeout(r, Math.min(5000, (globalFails.n - 30) * 200)));
      const b = await readBody(req);
      if (!sameStr(String(b.pin || '').trim(), CASHIER_PIN)) { globalFails.n++; loginFails.set(ip, { n: (f && now() - f.at < 15 * 60e3 ? f.n : 0) + 1, at: now() }); return json(res, { error: 'bad_pin', msg: 'الرمز غير صحيح' }, 401); }
      loginFails.delete(ip);
      const secure = /^https/.test(BASE) ? '; Secure' : '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `tj_c=${CASHIER_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure}`, 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/logout' && req.method === 'POST') { res.writeHead(200, { 'Set-Cookie': 'tj_c=; Path=/; Max-Age=0' }); return res.end('{}'); }
    if (p === '/api/me') { const c = isCashier(req); return json(res, { cashier: c, noPin: PIN_IS_DEFAULT, shortPin: c && PIN_TOO_SHORT }); }
    if (p === '/api/stats') { if (!isCashier(req)) return json(res, { error: 'auth' }, 401); return json(res, computeStats(Math.min(90, +(url.searchParams.get('days') || 30)))); }
    if (p === '/api/board') return json(res, [...orders.values()].filter(o => o.status !== 'picked' && now() - o.createdAt < 3 * 3600e3).map(boardOrder));
    if (p === '/' || p === '/cashier') return send(res, 200, page('cashier.html'));
    if (p === '/c') return send(res, 200, page('pick.html'));
    if ((m = p.match(/^\/o\/([a-f0-9]{10,16})$/))) {
      const o = orders.get(m[1]);
      // طلب قديم أو منتهي، مثل فتح أيقونة الشاشة الرئيسية في زيارة جديدة: نعرض قائمة الطلبات الحالية
      if (!o || o.status === 'picked') { res.writeHead(302, { Location: '/c?app=1', 'Cache-Control': 'no-store' }); return res.end(); }
      if (isCashier(req)) return send(res, 200, page('order.html', BASE, { NUMBER: o.number, OID: o.id }));
      let key = clientKey(req, o); const headers = {};
      if (!key) {
        if (o.clients.size >= MAX_CLIENTS_PER_ORDER) return send(res, 409, page('busy.html', BASE, { NUMBER: o.number }));
        key = crypto.randomBytes(12).toString('hex'); o.clients.add(key); if (!o.meta.ua) o.meta.ua = String(req.headers['user-agent'] || '').slice(0, 160); log(o, 'client_joined', { n: o.clients.size, ua: req.headers['user-agent'] });
        headers['Set-Cookie'] = `tj_o_${o.id}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${/^https/.test(BASE) ? '; Secure' : ''}`;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
      return res.end(page('order.html', BASE, { NUMBER: o.number, OID: o.id }));
    }
    if (p === '/.well-known/apple-app-site-association') return send(res, 200, fs.readFileSync(path.join(__dirname, 'appclip/apple-app-site-association')), 'application/json');
    if (p === '/sw.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public/sw.js')), 'text/javascript');
    if (p === '/chime.mp3') return send(res, 200, fs.readFileSync(path.join(__dirname, 'assets/chime.mp3')), 'audio/mpeg');
    if ((m = p.match(/^\/stream\/([a-f0-9]+)$/))) { const o = orders.get(m[1]); if (!o || o.status === 'picked') return send(res, 404, ''); const k = clientKey(req, o); if (!k) return send(res, 403, ''); return startStream(o, req, res, k, url.searchParams.get('test') === '1'); }
    if ((m = p.match(/^\/qr\/([a-f0-9]+|cafe|app)\.svg$/))) {
      const target = m[1] === 'cafe' ? `${BASE}/c` : m[1] === 'app' ? `${BASE}/app` : `${BASE}/o/${m[1]}`;
      return send(res, 200, await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), 'image/svg+xml');
    }
    if (p === '/qr.svg') { const tx = String(url.searchParams.get('text') || '').slice(0, 300); if (!/^WIFI:/.test(tx)) return send(res, 400, ''); return send(res, 200, await QRCode.toString(tx, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), 'image/svg+xml'); }
    if (p === '/manifest.webmanifest') return send(res, 200, JSON.stringify({
      id: '/', name: 'طلبك جاهز', short_name: 'طلبك جاهز', lang: 'ar', dir: 'rtl', display: 'standalone', start_url: '/app', scope: '/',
      background_color: '#f6f3ee', theme_color: '#0f3d2e',
      icons: [192, 512].map(n => ({ src: `/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' })) }), 'application/manifest+json');
    if ((m = p.match(/^\/(ready-banner|ready-art|wait-art|badge)\.png$/))) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(fs.readFileSync(path.join(__dirname, `assets/${m[1]}.png`))); }
    if ((m = p.match(/^\/(?:apple-touch-icon|icon-(180|192|512))(?:-precomposed)?\.png$/))) return send(res, 200, fs.readFileSync(path.join(__dirname, `assets/icon-${m[1] || 180}.png`)), 'image/png');
    if (p === '/app') return send(res, 200, page('app.html', BASE));
    if (p === '/board') return send(res, 200, page('board.html', BASE));
    if (p === '/api/devices' && req.method === 'POST') {
      const b = await readBody(req); const id = String(b.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40); if (!id) return json(res, { error: 'id' }, 400);
      if (id === 'sw') { console.log('sw event:', b.state); return json(res, { ok: true }); }
      let d = devices.get(id); if (!d) { d = { id, subs: [], phone: '', ua: String(req.headers['user-agent'] || '').slice(0, 80), createdAt: now(), log: [] }; devices.set(id, d); devLog(d, 'created'); }
      d.lastSeen = now();
      if (b.sub && b.sub.endpoint && (validSub(b.sub) || ALLOW_TEST_PUSH_HOSTS)) { if (!d.subs.some(x => x.endpoint === b.sub.endpoint)) { d.subs = [{ endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } }]; devLog(d, 'subscribed', { host: new URL(b.sub.endpoint).host }); } }
      if (b.phone !== undefined) { const ph = normPhone(b.phone); if (ph !== d.phone) { d.phone = ph; d.phoneVerified = ''; devLog(d, 'phone_set', { tail: ph.slice(-4) }); } }
      if (b.state) devLog(d, 'state', { state: String(b.state).replace(/[<>]/g, '').slice(0, 80) });
      saveDevices();
      return json(res, { ok: true, id, subscribed: d.subs.length > 0, phoneTail: d.phone.slice(-4), phoneVerified: !!d.phone && d.phoneVerified === d.phone, apple: d.subs.some(isApple) });
    }
    if ((m = p.match(/^\/api\/devices\/([a-z0-9]+)\/(test|report)$/i))) {
      const d = devices.get(m[1]); if (!d) return json(res, { error: 'no_device' }, 404);
      const b = await readBody(req);
      if (m[2] === 'report') { const r = ['ok', 'silent', 'none'].includes(b.result) ? b.result : 'other'; devLog(d, 'test_report', { result: r }); d.lastTest = r; return json(res, { ok: true }); }
      if (d.lastTestAt && now() - d.lastTestAt < 10e3) return json(res, { ok: false, error: 'slow_down' }, 429); d.lastTestAt = now();
      if (!d.subs.length) return json(res, { ok: false, error: 'no_sub' });
      const n = { title: '✅ تجربة التنبيه', body: 'إذا سمعت صوت أو حسيت اهتزاز فكل شي تمام', tag: `test-${Date.now()}`, url: `${BASE}/app?test=1`, dev: d.id };
      const out = [];
      for (const sub of d.subs) { try { const r = await pushTo(sub, n, BASE); out.push(r.statusCode); devLog(d, 'test_sent', { status: r.statusCode, apple: isApple(sub) }); }
        catch (e) { out.push(e.statusCode || 0); devLog(d, 'test_error', { status: e.statusCode, msg: String(e.body || e.message).slice(0, 80) }); } }
      return json(res, { ok: out.every(c => c >= 200 && c < 300), status: out });
    }
    if (p === '/api/devices' && req.method === 'GET') if (!isCashier(req)) return json(res, { error: 'auth' }, 401); else return json(res, [...devices.values()].map(d => ({ id: d.id, subs: d.subs.length, apple: d.subs.some(isApple), phoneTail: d.phone.slice(-4), ua: d.ua, lastTest: d.lastTest, log: (d.log || []).slice(-8) })));
    if (p === '/sticker') return send(res, 200, page('sticker.html', BASE));
    if ((m = p.match(/^\/events\/([a-f0-9]+)$/))) {
      const o = orders.get(m[1]); if (!o) return send(res, 404, '');
      if (!clientKey(req, o) && !isCashier(req)) return send(res, 403, '');
      if ((sseClients.get(o.id)?.size || 0) >= 6) return send(res, 429, '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      if (!sseClients.has(o.id)) sseClients.set(o.id, new Set()); sseClients.get(o.id).add(res); sse(o);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); sseClients.get(o.id)?.delete(res); }); return;
    }
    // API
    if (p.startsWith('/api/orders') && req.method === 'GET' && !isCashier(req)) return json(res, { error: 'auth' }, 401);
    if (p === '/api/orders' && req.method === 'GET') return json(res, [...orders.values()].filter(o => now() - o.createdAt < 6 * 3600e3).reverse().map(publicOrder));
    if (p === '/api/open' && req.method === 'GET') return json(res, [...orders.values()].filter(o => o.status !== 'picked' && now() - o.createdAt < 90 * 60e3).sort((a, b) => Number(a.number) - Number(b.number)).map(o => ({ number: o.number, ready: o.status === 'ready' })));
    if (p === '/api/join' && req.method === 'POST') {
      const b = await readBody(req); const n = String(b.number || '').trim();
      const o = [...orders.values()].reverse().find(x => x.number === n && x.status !== 'picked' && now() - x.createdAt < 90 * 60e3);
      if (!o) return json(res, { error: 'not_found' }, 404);
      return json(res, { url: `/o/${o.id}` });
    }
    if (p === '/api/orders' && req.method === 'POST') { if (!isCashier(req)) return json(res, { error: 'auth' }, 401); const b = await readBody(req); const o = newOrder(b.number, 'cashier', { phone: b.phone }); o.base = BASE; return json(res, publicOrder(o)); }
    if ((m = p.match(/^\/api\/orders\/([a-f0-9]+)(?:\/(ready|picked|ack|push|apns|ping|test|phone|claim|table|undo|unpick))?$/))) {
      const o = orders.get(m[1]); if (!o) return json(res, { error: 'not found' }, 404);
      const a = m[2]; const b = req.method === 'POST' ? await readBody(req) : {};
      const cashier = isCashier(req); const ck = clientKey(req, o);
      if (['ready', 'picked', 'phone', 'undo', 'unpick'].includes(a) && !cashier) return json(res, { error: 'auth' }, 401);
      if (['ack', 'push', 'apns', 'ping', 'test', 'claim'].includes(a) && !ck && !cashier) return json(res, { error: 'no_client' }, 403);
      if (a === 'table' && !ck && !cashier) return json(res, { error: 'no_client' }, 403);
      if (a === 'ready') setReady(o, 'cashier');
      else if (a === 'undo') { if (!(await undoReady(o))) return json(res, { error: 'too_late' }, 409); }
      else if (a === 'picked') setPicked(o);
      else if (a === 'unpick') { if (!undoPicked(o)) return json(res, { error: 'too_late' }, 409); }
      else if (a === 'ack') { if (ck) o.acks.add(ck); if (!o.ackAt && o.status === 'ready') { o.ackAt = now(); log(o, 'customer_ack'); evalAlert(o); } }
      else if (a === 'push' && b.endpoint) { if (!validSub(b) && !ALLOW_TEST_PUSH_HOSTS) return json(res, { error: 'bad_endpoint' }, 400); if (!o.push.some(s => s.endpoint === b.endpoint) && o.push.length < 3) o.push.push({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } }); log(o, 'webpush_subscribed', { host: new URL(b.endpoint).host }); }
      else if (a === 'apns' && /^[a-f0-9]{64,200}$/i.test(String(b.token || ''))) { if (!o.apns.includes(b.token) && o.apns.length < 3) o.apns.push(String(b.token)); log(o, 'apns_registered'); }
      else if (a === 'ping') { const st = String(b.state || '').replace(/[<>]/g, '').slice(0, 80); if (st === 'heard_yes') o.heard = true; markAlert(o, st); log(o, 'page', { state: st }); }
      else if (a === 'test') { for (const st of o.streams) if (st.key === ck) st.testTone = true; log(o, 'test_tone'); }
      else if (a === 'phone') { o.phone = normPhone(b.phone); log(o, 'phone_set', { tail: o.phone.slice(-4), linked: devicesForOrder(o).length }); }
      else if (a === 'table') { o.table = String(b.table || '').replace(/[^0-9A-Za-z\u0600-\u06FF ]/g, '').slice(0, 12); log(o, 'table_set', { table: o.table }); }
      else if (a === 'claim' && b.device && devices.has(String(b.device))) { const dv = devices.get(String(b.device)); if (o.phone && dv.phone === o.phone && dv.phoneVerified !== o.phone) { dv.phoneVerified = o.phone; devLog(dv, 'phone_verified'); } o.devices.add(String(b.device)); log(o, 'device_claimed', { linked: devicesForOrder(o).length }); }
      return json(res, cashier ? publicOrder(o) : customerOrder(o));
    }
    // تكامل Foodics (هيكل مبدئي): ينشئ الطلب عند وصول حدث إنشاء، ويعلن الجاهزية عند وصول حالة "منتهٍ".
    // أسماء الحقول تحتاج إلى مطابقة مع وثائق Foodics الرسمية قبل الإنتاج.
    if (p === '/webhooks/foodics' && req.method === 'POST') {
      if (!process.env.FOODICS_SECRET || !sameStr(url.searchParams.get('key') || '', process.env.FOODICS_SECRET)) return json(res, { error: 'disabled_or_bad_key' }, 403);
      const b = await readBody(req); const ord = b.order || b.data?.order || b;
      const ref = String(ord.reference ?? ord.number ?? ord.id ?? '');
      let o = [...orders.values()].find(x => x.meta.foodicsRef === ref);
      if (!o) o = newOrder(ord.reference ?? undefined, 'foodics', { foodicsRef: ref, phone: ord.customer?.phone || ord.customer_phone || ord.phone });
      const st = String(ord.status ?? ord.kitchen_status ?? '').toLowerCase();
      if (['ready', 'done', '4', 'prepared'].includes(st)) setReady(o, 'foodics');
      return json(res, { ok: true, id: o.id });
    }
    send(res, 404, 'Not found');
  } catch (e) { console.error(e); send(res, 500, 'error'); }
});
// تنظيف دوري: الطلبات الأقدم من 12 ساعة، ومحاولات الدخول القديمة، والجوالات غير المستخدمة منذ 90 يوما
setInterval(() => {
  for (const [id, o] of orders) if (now() - o.createdAt > 12 * 3600e3 && !o.streams.size) { clearInterval(o.repeatTimer); orders.delete(id); sseClients.delete(id); }
  for (const [ip, f] of loginFails) if (now() - f.at > 15 * 60e3) loginFails.delete(ip);
  let pruned = false; for (const [id, d] of devices) if (now() - (d.lastSeen || d.createdAt || 0) > 90 * 864e5) { devices.delete(id); pruned = true; }
  if (pruned) saveDevices();
}, 3600e3);
server.keepAliveTimeout = 120000;
server.headersTimeout = 30000;
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`الخادم يعمل محليا على http://localhost:${PORT}/cashier`));
module.exports = { setPublicUrl, server };
