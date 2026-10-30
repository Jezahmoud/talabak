require('./_auth');
const { chromium, devices } = require('playwright');
const B = 'http://localhost:3999';
(async () => {
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  // 1) ايفون داخل Safari (ليس تطبيقا): يجب أن يظهر دليل الإضافة بخطواته
  for (const [label, ua] of [['iOS 18', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'],
                             ['iOS 26', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1']]) {
    const ctx = await br.newContext({ ...devices['iPhone 13'], userAgent: ua }); const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(B + '/app'); await pg.waitForTimeout(600);
    console.log(label, 'guide:', await pg.isVisible('#guide'), 'steps:', await pg.locator('#steps .step').count(), 'main hidden:', !(await pg.isVisible('#main')), 'errors:', errs.join('|') || 'none');
    await ctx.close();
  }
  // 2) داخل تطبيق الشاشة الرئيسية (نحاكيه بـ force=1): الواجهة الرئيسية + الطلبات + تسجيل الجهاز، ثم صفحة الطلب في وضع التطبيق
  const ctx = await br.newContext({ ...devices['iPhone 13'], permissions: ['notifications'] }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const o = await (await fetch(B + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  await pg.goto(B + '/app?force=1'); await pg.waitForTimeout(1200);
  console.log('app view: main', await pg.isVisible('#main'), '| enable btn', await pg.isVisible('#enable'), '| orders grid count', await pg.locator('#g a').count(), '| errors:', errs.join('|') || 'none');
  const devId = await pg.evaluate(() => localStorage.getItem('talabak_dev'));
  await pg.fill('#phone', '0551234567'); await pg.click('#savephone'); await pg.waitForTimeout(400);
  console.log('phone saved text:', await pg.textContent('#phoneok'));
  pg.once('dialog', d => d.accept()); await pg.locator('#g a', { hasText: new RegExp('^' + o.number + '$') }).click(); await pg.waitForURL(/\/o\//); await pg.waitForTimeout(1200);
  console.log('order page url has app=1:', pg.url().includes('app=1'), '| arm text:', (await pg.textContent('#arm')).trim(), '| armed visible:', await pg.isVisible('#armed'), '| errors:', errs.join('|') || 'none');
  const devs = await (await fetch(B + '/api/devices')).json(); const d = devs.find(x => x.id === devId);
  const st = (await (await fetch(B + '/api/orders')).json()).find(x => x.id === o.id);
  console.log('device record:', JSON.stringify({ phoneTail: d.phoneTail, subs: d.subs, log: d.log.map(x => x.type + (x.state ? '[' + x.state + ']' : '')) }));
  console.log('order events:', st.events.map(e => e.type + (e.state ? '[' + e.state + ']' : '') + (e.linked != null ? '[linked=' + e.linked + ']' : '')).join(' > '));
  await br.close();
})().catch(e => { console.error(e); process.exit(1); });
