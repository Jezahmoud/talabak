// اختبار متصفح آلي (Chromium): تفعيل التنبيه، التحقق من تشغيل البث، ووصول حالة الجاهزية للصفحة
const { chromium } = require('playwright');
const B = 'http://localhost:3999';
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['notifications'] });
  const page = await ctx.newPage();
  const o = await (await fetch(B + '/api/orders', { method: 'POST' })).json();
  await page.goto(`${B}/o/${o.id}?mode=both`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('num').textContent));
  await page.click('#arm');
  await page.waitForTimeout(4000);
  const a = await page.evaluate(() => { const p = document.getElementById('player'); return { paused: p.paused, t: p.currentTime.toFixed(2), err: p.error && p.error.code }; });
  console.log('audio after 4s:', a);
  let st = (await (await fetch(B + '/api/orders')).json()).find(x => x.id === o.id);
  console.log('server sees streams:', st.streams.length, 'push subscribed:', st.pushCount);
  await fetch(`${B}/api/orders/${o.id}/ready`, { method: 'POST' });
  await page.waitForTimeout(1500);
  console.log('page status text:', await page.textContent('#status'), '| ready class:', await page.evaluate(() => document.body.classList.contains('ready')));
  await page.click('#ack');
  st = (await (await fetch(B + '/api/orders')).json()).find(x => x.id === o.id);
  console.log('reactionSec:', st.reactionSec, '\nevents:', st.events.map(e => e.type + (e.state ? `[${e.state}]` : '') + (e.status ? `[${e.status}]` : '') + (e.msg ? `[${e.msg.slice(0,60)}]` : '')).join(' > '));
  await page.screenshot({ path: '/tmp/order_ready.png' });
  const c = await ctx.newPage(); await c.setViewportSize({ width: 1100, height: 700 }); await c.goto(`${B}/cashier`); await c.waitForTimeout(1200); await c.screenshot({ path: '/tmp/cashier.png' });
  await browser.close();
})();
