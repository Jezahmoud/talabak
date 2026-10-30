require('./_auth');
// يختبر إرسال الإشعارات إلى خدمة وهمية محلية: صيغة Apple التصريحية بترويستها الصحيحة، وصيغة أندرويد التقليدية، وربط الطلب بالجهاز عبر رقم الجوال
const http = require('http'); const crypto = require('crypto'); const ece = require('http_ece');
const B = 'http://localhost:3999';
const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
function fakeSub(endpoint) {
  const e = crypto.createECDH('prime256v1'); e.generateKeys(); const auth = crypto.randomBytes(16);
  return { sub: { endpoint, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, ecdh: e, auth };
}
const got = [];
const mock = http.createServer((req, res) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(c) }); res.writeHead(201); res.end(); }); });
(async () => {
  await new Promise(r => mock.listen(4001, r));
  const apple = fakeSub('http://localhost:4001/web.push.apple.com/abc'), android = fakeSub('http://localhost:4001/fcm/send/xyz');
  // تسجيل جهازين: ايفون برقم جوال، وأندرويد بدون رقم
  console.log('register apple:', JSON.stringify(await post('/api/devices', { id: 'dev1apple', sub: apple.sub, phone: '0551234567' })));
  console.log('register android:', JSON.stringify(await post('/api/devices', { id: 'dev2android', sub: android.sub })));
  // تجربة التنبيه
  console.log('test apple:', JSON.stringify(await post('/api/devices/dev1apple/test')));
  // طلب برقم الجوال نفسه بصيغة دولية -> يرتبط بالجهاز تلقائيا
  const o = await post('/api/orders', { phone: '+966 55 123 4567' });
  console.log('order linkedDevices:', o.linkedDevices, 'phoneTail:', o.phoneTail);
  // أندرويد يختار الطلب من التطبيق
  await post(`/api/orders/${o.id}/claim`, { device: 'dev2android' });
  await post(`/api/orders/${o.id}/ready`);
  await new Promise(r => setTimeout(r, 800));
  const st = (await (await fetch(B + '/api/orders')).json()).find(x => x.id === o.id);
  console.log('linked after claim:', st.linkedDevices, '| events:', st.events.filter(e => e.type.startsWith('webpush')).map(e => `${e.type}:${e.status}:${e.via}:${e.apple}`).join(' '));
  for (const g of got) {
    const isApple = g.url.includes('apple');
    const dec = ece.decrypt(g.body, { version: 'aes128gcm', privateKey: isApple ? apple.ecdh : android.ecdh, authSecret: (isApple ? apple.auth : android.auth).toString('base64url') }).toString();
    console.log(`\n→ ${g.url}\n  content-type=${g.headers['content-type']} encoding=${g.headers['content-encoding']} ttl=${g.headers.ttl} urgency=${g.headers.urgency} vapid=${/vapid/.test(g.headers.authorization)}\n  payload=${dec}`);
  }
  mock.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
