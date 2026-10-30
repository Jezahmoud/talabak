require('./_auth');
const { chromium, devices } = require('playwright');
(async () => {
  const B='http://localhost:3999';
  const br = await chromium.launch({ args:['--autoplay-policy=no-user-gesture-required'] });
  for (const dev of ['iPhone 13','Pixel 7']) {
    const o = await (await fetch(B+'/api/orders',{method:'POST'})).json();
    const pg = await (await br.newContext({ ...devices[dev] })).newPage();
    const errs=[]; pg.on('pageerror', e=>errs.push(e.message));
    await pg.goto(`${B}/o/${o.id}`); await pg.click('#arm'); await pg.waitForTimeout(1500);
    const gate = { heard: await pg.isVisible('#heard'), armedBeforeYes: await pg.isVisible('#armed') };
    await pg.click('#no'); await pg.waitForTimeout(500); gate.louder = await pg.isVisible('#louder');
    await pg.click('#yes'); await pg.waitForTimeout(300); gate.armedAfterYes = await pg.isVisible('#armed');
    await fetch(`${B}/api/orders/${o.id}/ready`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    await pg.waitForTimeout(1500);
    const alarm = await pg.isVisible('#alarm');
    await pg.screenshot({ path:`/tmp/alarm-${dev.replace(' ','')}.png` });
    await pg.click('#ack2'); await pg.waitForTimeout(400);
    const st = (await (await fetch(B+'/api/orders')).json()).find(x=>x.id===o.id);
    console.log(dev, JSON.stringify(gate), 'alarm', alarm, 'hiddenAfterAck', !(await pg.isVisible('#alarm')), 'heardFlag', st.heard, 'acked', !!st.ackAt, 'errors', errs.join('|')||'none');
    console.log('  ', st.events.filter(e=>e.type==='page').map(e=>e.state).join(' > '));
  }
  await br.close();
})();
