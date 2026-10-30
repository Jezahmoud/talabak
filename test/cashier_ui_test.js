// يختبر لوحة الكاشير: شاشة الدخول، الرمز الخاطئ، الدخول، إنشاء طلب، جاهز، التراجع، وشريط انقطاع الاتصال
const { chromium } = require('playwright');
const B = 'http://localhost:3999';
(async () => {
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1200, height: 900 } }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(B + '/cashier'); await pg.waitForTimeout(600);
  console.log('login shown:', await pg.isVisible('#login'));
  await pg.fill('#pin', '0000'); await pg.click('#lf button'); await pg.waitForTimeout(400);
  console.log('bad pin msg:', await pg.textContent('#lerr'));
  await pg.fill('#pin', process.env.CASHIER_PIN || '1234'); await pg.click('#lf button'); await pg.waitForTimeout(800);
  console.log('login hidden:', !(await pg.isVisible('#login')), '| default pin warning:', await pg.isVisible('#pinwarn'));
  await pg.click('#new'); await pg.waitForTimeout(1800);
  const first = pg.locator('.card.fresh');
  await first.locator('.btn-ready').click(); await pg.waitForTimeout(1700);
  console.log('undo visible after ready:', await first.locator('.btn-undo').isVisible());
  await first.locator('.btn-undo').click(); await pg.waitForTimeout(1700);
  console.log('status after undo:', (await first.locator('.st').textContent()).trim());
  await pg.screenshot({ path: '/tmp/cashier_v16.png' });
  await ctx.route('**/api/orders', r => r.abort()); await pg.waitForTimeout(4000);
  console.log('offline banner:', await pg.isVisible('#offline'), '| errors:', errs.join('|') || 'none');
  await br.close();
})();
