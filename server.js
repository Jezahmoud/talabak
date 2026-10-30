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
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- VAPID (Web Push) ----------
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (fs.existsSync(vapidFile)) vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
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
const silence = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets', process.env.SILENCE_FILE || 'silence_64.mp3')));
// صمت بمعدل بت مرتفع للدفعة الأولى فقط: المتصفحات تنتظر عددا من البايتات (نحو 32 كيلوبايت في Chromium) قبل بدء التشغيل،
// فنملأ هذا الحد بأقصر مدة زمنية ممكنة حتى لا يتأخر التنبيه بعدها
const silenceHi = parseMp3Frames(fs.readFileSync(path.join(__dirname, 'assets/silence_hi.mp3')));
const FRAME_SEC = silence.frameSec;
const PREBUFFER_SEC = Number(process.env.PREBUFFER_SEC || 0.5);
const BURST_BYTES = Number(process.env.BURST_BYTES || 40000);             // دفعة أولى صغيرة ليبدأ التشغيل، ثم إيقاع حقيقي حتى لا يخزن الجهاز مسبقا
const CHIME_REPEAT_EVERY_SEC = 6;      // تكرار النغمة حتى يؤكد العميل أو تنتهي المهلة
const CHIME_MAX_SEC = 180;

// ---------- State ----------
const orders = new Map();              // id -> order
let nextNumber = 101;
const now = () => Date.now();
function newOrder(number, source = 'cashier', meta = {}) {
  const id = crypto.randomBytes(5).toString('hex');
  const o = { id, number: String(number ?? nextNumber++), status: 'waiting', source, meta, createdAt: now(), readyAt: null, ackAt: null, pickedAt: null,
    push: [], apns: [], streams: new Set(), events: [] };
  orders.set(id, o); log(o, 'created', { source }); return o;
}
function log(o, type, data = {}) { o.events.push({ t: now(), type, ...data }); if (o.events.length > 200) o.events.shift(); sse(o); }
function publicOrder(o) {
  const streams = [...o.streams].map(s => ({ ageSec: Math.round((now() - s.startedAt) / 1000), blocked: s.blocked,
    lastDrainAgoSec: Math.round((now() - s.lastFlowAt) / 1000), sentSec: Math.round(s.framesSent * FRAME_SEC), ua: s.ua }));
  return { id: o.id, number: o.number, status: o.status, createdAt: o.createdAt, readyAt: o.readyAt, ackAt: o.ackAt, pickedAt: o.pickedAt,
    pushCount: o.push.length, apnsCount: o.apns.length, streams, events: o.events.slice(-12),
    reactionSec: o.readyAt && o.ackAt ? Math.round((o.ackAt - o.readyAt) / 100) / 10 : null };
}

// ---------- Live audio stream ----------
// كل عميل فعّل التنبيه الصوتي يسحب بثا لا ينتهي: صمت شبه تام، وعند الجاهزية يحقن الخادم النغمة في البث نفسه.
// الهاتف لا يحتاج إلى تشغيل أي كود عند الجاهزية؛ مشغل الوسائط وحده يسحب البث ويشغل ما يصله.
function startStream(o, req, res) {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store, no-transform', 'Accept-Ranges': 'none',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const s = { res, startedAt: now(), framesSent: 0, blocked: false, lastFlowAt: now(), ua: (req.headers['user-agent'] || '').slice(0, 80),
    queue: [], silenceIdx: 0, nextChimeAt: 0, testTone: true };
  let acc = 0, k = 0; while (acc < BURST_BYTES) { const f = silenceHi.frames[k++ % silenceHi.frames.length]; s.queue.push(f); acc += f.length; }
  s.burstFrames = s.queue.length;
  o.streams.add(s); log(o, 'stream_open', { ua: s.ua });
  res.on('drain', () => { s.blocked = false; s.lastFlowAt = now(); });
  const close = () => { if (o.streams.delete(s)) log(o, 'stream_closed', { afterSec: Math.round((now() - s.startedAt) / 1000) }); };
  req.on('close', close); res.on('error', close);
}
function nextFrame(o, s) {
  if (s.queue.length) return s.queue.shift();
  const t = now();
  // نغمة تجريبية مرة واحدة عند البدء حتى يعرف العميل أن الصوت يعمل ويضبط مستواه
  if (s.testTone) { s.testTone = false; s.queue.push(...chime.frames); return s.queue.shift(); }
  if (o.status === 'ready' && !o.ackAt && t - o.readyAt < CHIME_MAX_SEC * 1000 && t >= s.nextChimeAt) {
    s.nextChimeAt = t + CHIME_REPEAT_EVERY_SEC * 1000;
    if (!s.chimeLogged) { s.chimeLogged = true; log(o, 'chime_injected', { delayMs: t - o.readyAt }); }
    s.queue.push(...chime.frames); return s.queue.shift();
  }
  const f = silence.frames[s.silenceIdx]; s.silenceIdx = (s.silenceIdx + 1) % silence.frames.length; return f;
}
setInterval(() => {
  const t = now();
  for (const o of orders.values()) for (const s of o.streams) {
    if (o.status === 'picked') { s.res.end(); o.streams.delete(s); continue; }
    const due = Math.floor(((t - s.startedAt) / 1000 + PREBUFFER_SEC) / FRAME_SEC) + s.burstFrames - s.framesSent;
    if (s.blocked || due <= 0) continue;
    const chunk = []; for (let k = 0; k < Math.min(due, 200); k++) chunk.push(nextFrame(o, s));
    s.framesSent += chunk.length;
    const ok = s.res.write(Buffer.concat(chunk));
    if (ok) s.lastFlowAt = t; else s.blocked = true;   // إذا توقف الجهاز عن القراءة نعرف ذلك هنا (ضغط عكسي من TCP)
  }
}, 50);

// ---------- Push channels ----------
async function notifyAll(o, repeat = false) {
  if (repeat && !o.push.length) return;
  const payload = JSON.stringify({ title: `${CAFE_NAME}`, body: `طلبك رقم ${o.number} جاهز، تفضل بالاستلام`, tag: `order-${o.id}`, url: `${o.base || PUBLIC_URL}/o/${o.id}` });
  for (const sub of o.push) {
    try { const r = await webpush.sendNotification(sub, payload, { TTL: 600, urgency: 'high' }); log(o, 'webpush_sent', { status: r.statusCode }); }
    catch (e) { log(o, 'webpush_error', { status: e.statusCode, msg: String(e.body || e.message).slice(0, 120) }); }
  }
  if (repeat) return;
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
function sse(o) { const set = sseClients.get(o.id); if (!set) return; const d = `data: ${JSON.stringify({ status: o.status, number: o.number })}\n\n`; for (const r of set) r.write(d); }

// ---------- Actions ----------
// عند الجاهزية: إشعار فوري ثم تكرار كل 12 ثانية حتى يستجيب العميل أو تمر 3 دقائق، فيهتز الجوال مع كل تكرار (أندرويد)
function setReady(o, by) {
  if (o.status !== 'waiting') return; o.status = 'ready'; o.readyAt = now(); log(o, 'ready', { by }); notifyAll(o);
  const iv = setInterval(() => {
    if (o.status !== 'ready' || o.ackAt || now() - o.readyAt > 180e3 || !o.push.length) return clearInterval(iv);
    notifyAll(o, true);
  }, 12000);
}
function setPicked(o) { o.status = 'picked'; o.pickedAt = now(); log(o, 'picked'); }

// ---------- HTTP ----------
function send(res, code, body, type = 'text/html; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function json(res, obj, code = 200) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
const page = (name, base = PUBLIC_URL) => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8')
  .replaceAll('{{CAFE}}', CAFE_NAME).replaceAll('{{VAPID}}', vapid.publicKey).replaceAll('{{BASE}}', base);

const server = http.createServer(async (req, res) => {
  const BASE = baseOf(req); const url = new URL(req.url, 'http://x'); const p = url.pathname; let m;
  try {
    if (p === '/health') return send(res, 200, 'ok v3', 'text/plain');
    if (p === '/' || p === '/cashier') return send(res, 200, page('cashier.html'));
    if (p === '/c') return send(res, 200, page('pick.html'));
    if ((m = p.match(/^\/o\/([a-f0-9]+)$/))) return orders.has(m[1]) ? send(res, 200, page('order.html')) : send(res, 404, 'الطلب غير موجود');
    if (p === '/.well-known/apple-app-site-association') return send(res, 200, fs.readFileSync(path.join(__dirname, 'appclip/apple-app-site-association')), 'application/json');
    if (p === '/sw.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public/sw.js')), 'text/javascript');
    if (p === '/chime.mp3') return send(res, 200, fs.readFileSync(path.join(__dirname, 'assets/chime.mp3')), 'audio/mpeg');
    if ((m = p.match(/^\/stream\/([a-f0-9]+)$/))) { const o = orders.get(m[1]); if (!o || o.status === 'picked') return send(res, 404, ''); return startStream(o, req, res); }
    if ((m = p.match(/^\/qr\/([a-f0-9]+|cafe)\.svg$/))) {
      const target = m[1] === 'cafe' ? `${BASE}/c` : `${BASE}/o/${m[1]}`;
      return send(res, 200, await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), 'image/svg+xml');
    }
    if (p === '/qr.svg') return send(res, 200, await QRCode.toString(String(url.searchParams.get('text') || '').slice(0, 500), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), 'image/svg+xml');
    if (p === '/sticker') return send(res, 200, page('sticker.html', BASE));
    if ((m = p.match(/^\/events\/([a-f0-9]+)$/))) {
      const o = orders.get(m[1]); if (!o) return send(res, 404, '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      if (!sseClients.has(o.id)) sseClients.set(o.id, new Set()); sseClients.get(o.id).add(res); sse(o);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); sseClients.get(o.id)?.delete(res); }); return;
    }
    // API
    if (p === '/api/orders' && req.method === 'GET') return json(res, [...orders.values()].filter(o => now() - o.createdAt < 6 * 3600e3).reverse().map(publicOrder));
    if (p === '/api/open' && req.method === 'GET') return json(res, [...orders.values()].filter(o => o.status === 'waiting' && now() - o.createdAt < 30 * 60e3).reverse().map(o => ({ id: o.id, number: o.number })));
    if (p === '/api/orders' && req.method === 'POST') { const b = await readBody(req); const o = newOrder(b.number); o.base = BASE; return json(res, publicOrder(o)); }
    if ((m = p.match(/^\/api\/orders\/([a-f0-9]+)(?:\/(ready|picked|ack|push|apns|ping|test))?$/))) {
      const o = orders.get(m[1]); if (!o) return json(res, { error: 'not found' }, 404);
      const a = m[2]; const b = req.method === 'POST' ? await readBody(req) : {};
      if (a === 'ready') setReady(o, 'cashier');
      else if (a === 'picked') setPicked(o);
      else if (a === 'ack') { if (!o.ackAt) { o.ackAt = now(); log(o, 'customer_ack'); } }
      else if (a === 'push' && b.endpoint) { if (!o.push.some(s => s.endpoint === b.endpoint)) o.push.push(b); log(o, 'webpush_subscribed', { host: new URL(b.endpoint).host }); }
      else if (a === 'apns' && b.token) { if (!o.apns.includes(b.token)) o.apns.push(b.token); log(o, 'apns_registered'); }
      else if (a === 'ping') log(o, 'page', { state: String(b.state || '').slice(0, 40) });
      else if (a === 'test') { for (const st of o.streams) st.testTone = true; log(o, 'test_tone'); }
      return json(res, publicOrder(o));
    }
    // تكامل Foodics (هيكل مبدئي): ينشئ الطلب عند وصول حدث إنشاء، ويعلن الجاهزية عند وصول حالة "منتهٍ".
    // أسماء الحقول تحتاج إلى مطابقة مع وثائق Foodics الرسمية قبل الإنتاج.
    if (p === '/webhooks/foodics' && req.method === 'POST') {
      const b = await readBody(req); const ord = b.order || b.data?.order || b;
      const ref = String(ord.reference ?? ord.number ?? ord.id ?? '');
      let o = [...orders.values()].find(x => x.meta.foodicsRef === ref);
      if (!o) o = newOrder(ord.reference ?? undefined, 'foodics', { foodicsRef: ref });
      const st = String(ord.status ?? ord.kitchen_status ?? '').toLowerCase();
      if (['ready', 'done', '4', 'prepared'].includes(st)) setReady(o, 'foodics');
      return json(res, { ok: true, id: o.id });
    }
    send(res, 404, 'Not found');
  } catch (e) { console.error(e); send(res, 500, 'error'); }
});
server.keepAliveTimeout = 120000;
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`الخادم يعمل محليا على http://localhost:${PORT}/cashier`));
module.exports = { setPublicUrl, server };
