const { customerCookie } = require('./_auth');
// اختبار خادم: هل يحقن الخادم النغمة في البث الحي بعد إعلان الجاهزية؟ وكم التأخير؟
const http = require('http'); const fs = require('fs'); const { execFileSync } = require('child_process');
const B = 'http://localhost:3999';
const post = p => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
(async () => {
  const o = await post('/api/orders'); const ck = await customerCookie(B, o.id); const t0 = Date.now(); const chunks = []; let bytes = 0;
  http.get(`${B}/stream/${o.id}?test=1`, { headers: { Cookie: ck } }, res => {
    console.log('status', res.statusCode, res.headers['content-type']);
    res.on('data', c => { chunks.push(c); bytes += c.length; });
  });
  setTimeout(async () => { const r = await post(`/api/orders/${o.id}/ready`); console.log('ready at wall', ((Date.now() - t0) / 1000).toFixed(2), 's'); }, 6000);
  setTimeout(async () => {
    const buf = Buffer.concat(chunks); fs.writeFileSync('/tmp/cap.mp3', buf);
    console.log('received bytes', bytes, 'over', ((Date.now() - t0) / 1000).toFixed(1), 's =>', (bytes * 8 / ((Date.now() - t0) / 1000) / 1000).toFixed(1), 'kbps');
    const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '/tmp/cap.mp3', '-f', 's16le', '-ac', '1', '-ar', '8000', '-']);
    const win = 800; const rows = [];
    for (let i = 0; i + win * 2 <= pcm.length; i += win * 2) { let s = 0; for (let k = 0; k < win; k++) { const v = pcm.readInt16LE(i + k * 2); s += v * v; } rows.push(Math.sqrt(s / win)); }
    const loud = rows.map(r => r > 1000 ? '#' : '.').join('');
    console.log('media timeline (each char = 0.1s):\n' + loud);
    const first = loud.indexOf('#', 40); console.log('chime onset in media timeline at', (first / 10).toFixed(1), 's');
    const st = await (await fetch(B + '/api/orders')).json();
    console.log(st.find(x=>x.id===o.id).events.map(e=>e.type+(e.delayMs!=null?`(${e.delayMs}ms)`:'')).join(' > '));
    process.exit(0);
  }, 14000);
})();
