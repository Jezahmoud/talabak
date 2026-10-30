const { chromium, devices } = require('playwright');
(async () => {
  const B='http://localhost:3999';
  const o = await (await fetch(B+'/api/orders',{method:'POST'})).json();
  const br = await chromium.launch({ headless: !process.env.DISPLAY });
  const ctx = await br.newContext({ ...devices['Pixel 7'], permissions:['notifications'] });
  const pg = await ctx.newPage(); await pg.goto(`${B}/o/${o.id}`);
  await pg.click('#arm'); await pg.waitForTimeout(5000);
  const st = await (await fetch(B+'/api/orders')).json();
  console.log(st.find(x=>x.id===o.id).events.filter(e=>e.type!=='stream_open').map(e=>e.type+(e.state?'['+e.state+']':'')+(e.host?'['+e.host+']':'')).join('\n'));
  await br.close();
})();
