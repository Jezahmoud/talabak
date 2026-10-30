// يجعل fetch في الاختبارات يدخل لوحة الكاشير تلقائيا بالرمز (CASHIER_PIN أو 1234) ويرسل الكوكي مع كل طلب محلي
const orig = globalThis.fetch; let cookie = null, pending = null;
async function login(base) {
  const r = await orig(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: process.env.CASHIER_PIN || '1234' }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
}
globalThis.fetch = async (u, opt = {}) => {
  const s = String(u);
  if (/^http:\/\/localhost/.test(s) && !/\/api\/login$/.test(s)) {
    if (!cookie) { pending = pending || login(new URL(s).origin); await pending; }
    opt = { ...opt, headers: { ...(opt.headers || {}), Cookie: cookie } };
  }
  return orig(u, opt);
};
module.exports = { getCookie: () => cookie };
