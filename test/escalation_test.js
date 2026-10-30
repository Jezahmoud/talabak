// يختبر محرك التصعيد: طلب بلا أي قناة يصبح أحمر بعد 15 ث، وطلب يسحب البث يبقى أخضر، وطلب رآه العميل يصبح مؤكدا
const B = 'http://localhost:3999';
const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
const get = async id => (await (await fetch(B + '/api/orders')).json()).find(x => x.id === id);
(async () => {
  const a = await post('/api/orders'), b = await post('/api/orders'), c = await post('/api/orders');
  // b يسحب البث فعلا
  const ctrl = new AbortController(); fetch(`${B}/stream/${b.id}`, { signal: ctrl.signal }).then(r => { const rd = r.body.getReader(); (async () => { while (true) { const { done } = await rd.read(); if (done) break; } })().catch(() => {}); });
  await new Promise(r => setTimeout(r, 1000));
  for (const o of [a, b, c]) await post(`/api/orders/${o.id}/ready`);
  await post(`/api/orders/${c.id}/ping`, { state: 'ready_screen_seen' });
  await new Promise(r => setTimeout(r, 4000));
  console.log('after 4s  → no channel:', JSON.stringify((await get(a.id)).alert), '| audio:', JSON.stringify((await get(b.id)).alert), '| seen:', JSON.stringify((await get(c.id)).alert));
  await new Promise(r => setTimeout(r, 14000));
  console.log('after 18s → no channel:', JSON.stringify((await get(a.id)).alert), '| audio:', JSON.stringify((await get(b.id)).alert));
  ctrl.abort(); process.exit(0);
})();
