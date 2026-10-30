// قياس زمن الوصول المسموع في Chromium: من ضغط الكاشير "جاهز" حتى خروج النغمة فعليا من مشغل الصفحة
// (نقيس الإشارة الصوتية الخارجة من عنصر الصوت بمحلل Web Audio، لا مجرد وصول البيانات)
const { chromium } = require('playwright');
const B = process.argv[2] || 'http://localhost:4061';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await b.newPage();
  const o = await (await fetch(B + '/api/orders', { method: 'POST' })).json();
  await p.goto(`${B}/o/${o.id}?mode=audio`); await p.click('#arm');
  await p.evaluate(() => {
    const a = document.getElementById('player'); const ctx = new AudioContext(); const src = ctx.createMediaElementSource(a);
    const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an); an.connect(ctx.destination);
    const d = new Float32Array(an.fftSize); window.onsets = []; let loud = false;
    setInterval(() => { an.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; const r = Math.sqrt(s / d.length);
      if (r > 0.05 && !loud) { loud = true; window.onsets.push(Date.now()); } if (r < 0.01) loud = false; }, 20);
  });
  const results = [];
  for (const waitSec of [20, 45]) {
    await p.waitForTimeout(waitSec * 1000);
    const before = (await p.evaluate(() => window.onsets.length));
    const tReady = Date.now(); await fetch(`${B}/api/orders/${o.id}/ready`, { method: 'POST' });
    await p.waitForTimeout(12000);
    const ons = await p.evaluate(() => window.onsets);
    const first = ons.slice(before).find(t => t >= tReady);
    results.push({ armedForSec: waitSec, audibleLatencySec: first ? ((first - tReady) / 1000).toFixed(2) : 'لم تُسمع' });
    // إعادة الطلب إلى الانتظار لتجربة ثانية
    const r = await fetch(`${B}/api/orders`, { method: 'POST' }); const o2 = await r.json(); o.id = o2.id;
    await p.goto(`${B}/o/${o.id}?mode=audio`); await p.click('#arm');
    await p.evaluate(() => { const a = document.getElementById('player'); const ctx = new AudioContext(); const src = ctx.createMediaElementSource(a);
      const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an); an.connect(ctx.destination); const d = new Float32Array(an.fftSize); window.onsets = []; let loud = false;
      setInterval(() => { an.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; const r = Math.sqrt(s / d.length); if (r > 0.05 && !loud) { loud = true; window.onsets.push(Date.now()); } if (r < 0.01) loud = false; }, 20); });
  }
  console.log(results);
  await b.close();
})();
