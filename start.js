// تشغيل التجربة بأمر واحد: يشغل الخادم ويفتح رابط HTTPS عاما مؤقتا عبر Cloudflare (مجاني ودون حساب)
'use strict';
const os = require('os');
const QRCode = require('qrcode');
const PORT = Number(process.env.PORT || 3000);
process.env.PORT = String(PORT);
const { setPublicUrl } = require('./server');

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
}

async function main() {
  console.log('\nجاري فتح رابط عام آمن (HTTPS)... قد يستغرق ذلك حتى 30 ثانية\n');
  let Tunnel;
  try { ({ Tunnel } = require('cloudflared')); } catch { return fallback('حزمة cloudflared غير مثبتة. شغل npm install أولا.'); }
  const t = Tunnel.quick(`http://localhost:${PORT}`);
  const timer = setTimeout(() => fallback('لم يُفتح الرابط العام خلال 60 ثانية.'), 60000);
  t.once('url', async url => {
    clearTimeout(timer);
    global.__TUNNEL_URL = url; setPublicUrl(url);
    const cashier = `${url}/cashier`;
    console.log('==============================================================');
    console.log(' جاهز للتجربة');
    console.log(` افتح لوحة الكاشير على اللابتوب:\n   ${cashier}`);
    console.log(' أو امسح هذا الرمز لفتحها على جهاز آخر:');
    console.log(await QRCode.toString(cashier, { type: 'terminal', small: true }));
    openBrowser(cashier);
    console.log(' اترك هذه النافذة مفتوحة طوال التجربة. للإيقاف اضغط Ctrl+C');
    console.log('==============================================================\n');
  });
  t.on('error', e => fallback('تعذر فتح الرابط العام: ' + e.message));
  process.on('SIGINT', () => { try { t.stop(); } catch {} process.exit(0); });
}
function openBrowser(u) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? `open "${u}"` : process.platform === 'win32' ? `start "" "${u}"` : `xdg-open "${u}"`;
  exec(cmd, () => {});
}
let fellBack = false;
function fallback(why) {
  if (fellBack) return; fellBack = true;
  console.log(`\n${why}`);
  console.log('يمكنك مع ذلك تجربة البث الصوتي فقط (دون إشعارات المتصفح) إذا كان الجوالان على شبكة الواي فاي نفسها:');
  for (const u of lanUrls()) console.log(`   ${u}/cashier`);
  console.log('');
}
main();
