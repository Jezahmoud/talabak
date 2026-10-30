require('./_auth');
const { chromium, devices } = require('playwright');
(async () => {
  const B='http://localhost:3999';
  const o = await (await fetch(B+'/api/orders',{method:'POST'})).json();
  const br = await chromium.launch({ args:['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await br.newContext({ ...devices['iPhone 13'] });
  const pg = await ctx.newPage(); await pg.goto(`${B}/o/${o.id}`);
  await pg.click('#arm'); await pg.waitForTimeout(2500);
  console.log('vib card visible:', await pg.isVisible('#vib'));
  console.log('manifest link:', await pg.getAttribute('link[rel=manifest]','href'));
  const st = await (await fetch(B+'/api/orders')).json();
  console.log('last events:', st.find(x=>x.id===o.id).events.map(e=>e.type+(e.state?'['+e.state+']':'')).join(' > '));
  await br.close();
})();
