// מעקב עומס: חיבורים בו-זמנית למסד הנתונים (משותפים לשלוחים ולהדגמה), תור ההדגמה ודחיות "עומס".
// הנתונים בזיכרון — לפי דקה, ל-24 השעות האחרונות (מתאפסים בהפעלה מחדש של השרת).
// כשמתקרבים לתקרה — SMS למנהל (לכל היותר פעם בשעה), ותיעוד ביומן הפעולות.
// SMS נשלח רק בחלון הבוקר (8:00, ביום חול); התראות מחוץ לחלון נאספות ונשלחות כסיכום אחד בבוקר.
import { pool, q, dbStorage } from './db.js';
import { audit } from './audit.js';
import { sendSms, normalizePhone, smsConfigured, inSendWindow } from './sms.js';

export const POOL_MAX = pool.options.max;
const DAY = 24 * 60;
const COOLDOWN = 60 * 60 * 1000;
export const startedAt = new Date();

const buckets = new Map(); // מספר דקה → { inUse, waiting, demo, demoQueue, rejects }
const demo = { active: 0, queue: 0, max: 0 };
const alerts = []; // התראות אחרונות (להצגה)
let lastAlert = 0;

const minuteNow = () => Math.floor(Date.now() / 60000);
function bucket() {
  const m = minuteNow();
  let b = buckets.get(m);
  if (!b) {
    b = { inUse: 0, waiting: 0, demo: 0, demoQueue: 0, rejects: 0 };
    buckets.set(m, b);
    for (const k of buckets.keys()) if (k <= m - DAY) buckets.delete(k);
  }
  return b;
}

export function current() {
  return { inUse: pool.totalCount - pool.idleCount, waiting: pool.waitingCount, max: POOL_MAX, demoActive: demo.active, demoQueue: demo.queue, demoMax: demo.max };
}

function sample() {
  const c = current(), b = bucket();
  b.inUse = Math.max(b.inUse, c.inUse);
  b.waiting = Math.max(b.waiting, c.waiting);
  b.demo = Math.max(b.demo, c.demoActive);
  b.demoQueue = Math.max(b.demoQueue, c.demoQueue);
  check(c);
}

// מצב תור ההדגמה (נקרא מ-server.js)
export function noteDemo(active, queue, max) {
  Object.assign(demo, { active, queue, max });
  sample();
}
export function noteDemoReject() {
  bucket().rejects++;
  sample();
}

// ההגדרות נשמרות גם בזיכרון: בזמן עומס אין חיבור פנוי למסד, וההתראה לא צריכה לחכות לו
let cached = null;
export async function alertSettings() {
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  const { rows } = await q(`SELECT key, value FROM app_settings WHERE key IN ('alert_phone', 'alert_pct')`);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const pct = parseInt(v.alert_pct, 10);
  const value = { phone: v.alert_phone || process.env.ADMIN_PHONE || '', pct: [60, 70, 80, 90].includes(pct) ? pct : 80 };
  cached = { at: Date.now(), value };
  return value;
}
export async function saveAlertSettings({ phone, pct }) {
  for (const [k, v] of [['alert_phone', phone], ['alert_pct', String(pct)]]) {
    await q(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, v]);
  }
  cached = null;
}

const rejects10 = () => { let n = 0; const m = minuteNow(); for (let k = m - 9; k <= m; k++) n += buckets.get(k)?.rejects || 0; return n; };

let checking = false;
// השיא שנראה מאז תחילת הבדיקה הנוכחית — העומס יכול לעלות בזמן שהבדיקה רצה
const seen = { inUse: 0, waiting: 0 };
function check(c) {
  if (checking) {
    seen.inUse = Math.max(seen.inUse, c.inUse);
    seen.waiting = Math.max(seen.waiting, c.waiting);
    return;
  }
  if (Date.now() - lastAlert < COOLDOWN) return;
  const quick = c.waiting > 0 || c.inUse >= Math.ceil(POOL_MAX * 0.6) || rejects10() >= 5;
  if (!quick) return; // רוב הזמן — בלי לגשת למסד
  checking = true;
  seen.inUse = c.inUse; seen.waiting = c.waiting;
  // מחוץ להקשר של בקשת הדגמה (שם SMS ושאילתות רצות על חיבור ההדגמה / חסומים)
  dbStorage.exit(() => evaluate(c).catch((e) => console.error('monitor:', e.message)).finally(() => { checking = false; }));
}

async function evaluate(first) {
  const { phone, pct } = await alertSettings();
  const c = { inUse: Math.max(first.inUse, seen.inUse), waiting: Math.max(first.waiting, seen.waiting) };
  const limit = Math.ceil(POOL_MAX * pct / 100), rj = rejects10();
  const reasons = [];
  if (c.inUse >= limit) reasons.push(`${c.inUse}/${POOL_MAX} חיבורים למסד בו-זמנית`);
  if (c.waiting > 0) reasons.push(`${c.waiting} בקשות ממתינות לחיבור`);
  if (rj >= 5) reasons.push(`${rj} כניסות להדגמה נדחו ("עומס") ב-10 דקות`);
  if (!reasons.length || Date.now() - lastAlert < COOLDOWN) return;
  lastAlert = Date.now();
  const text = `זכרתי התקשרתי — התראת עומס: ${reasons.join('; ')}. פרטים בדף המנהל ← עומס.`;
  const entry = { at: new Date(), text, sent: false, error: null };
  alerts.unshift(entry);
  alerts.length = Math.min(alerts.length, 20);
  const to = normalizePhone(phone);
  if (to && smsConfigured() && !inSendWindow()) {
    await deferAlert(reasons);
    entry.error = 'לא שולחים בשעה זו — יישלח כסיכום בבוקר';
  } else if (to && smsConfigured()) {
    try { await sendSms(to, text); entry.sent = true; } catch (e) { entry.error = e.message; }
  } else entry.error = to ? 'SMS לא מוגדר' : 'לא הוגדר נייד להתראות';
  audit({ actor: 'system', action: 'התראת עומס', outcome: entry.sent ? 'ok' : 'fail', detail: `${reasons.join('; ')}${entry.error ? ` — ${entry.error}` : ''}` });
}

// התראות שנדחו (לילה / שבת) — נשמרות במסד ונשלחות כהודעה אחת בחלון הבוקר
async function deferAlert(reasons) {
  const { rows: [r] } = await q(`SELECT value FROM app_settings WHERE key='load_alert_pending'`);
  const p = r ? JSON.parse(r.value) : { count: 0, first: new Date().toISOString(), reasons: [] };
  p.count++; p.last = new Date().toISOString(); p.reasons = reasons;
  await q(`INSERT INTO app_settings (key, value) VALUES ('load_alert_pending', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(p)]);
}
const fmtIL = (t) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
export async function flushDeferred() {
  if (!smsConfigured() || !inSendWindow()) return;
  const { rows: [r] } = await q(`DELETE FROM app_settings WHERE key='load_alert_pending' RETURNING value`);
  if (!r) return;
  const p = JSON.parse(r.value);
  const text = `זכרתי התקשרתי — סיכום עומס מהלילה: ${p.count === 1 ? 'התראה אחת' : `${p.count} התראות`} (${fmtIL(p.first)}${p.count > 1 ? `–${fmtIL(p.last)}` : ''}). האחרונה: ${p.reasons.join('; ')}. פרטים בדף המנהל ← עומס.`;
  const to = normalizePhone((await alertSettings()).phone);
  let error = to ? null : 'לא הוגדר נייד להתראות';
  if (to) { try { await sendSms(to, text); } catch (e) { error = e.message; } }
  audit({ actor: 'system', action: 'סיכום התראות עומס', outcome: error ? 'fail' : 'ok', detail: `${p.count} התראות${error ? ` — ${error}` : ''}` });
}
setInterval(() => flushDeferred().catch((e) => console.error('monitor flush:', e.message)), 10 * 60 * 1000).unref();

// הודעת ניסיון מדף המנהל
export async function sendTestAlert() {
  const { phone } = await alertSettings();
  const to = normalizePhone(phone);
  if (!to) throw new Error('לא הוגדר נייד תקין להתראות');
  await sendSms(to, `זכרתי התקשרתי — התראת עומס לניסיון. מצב נוכחי: ${current().inUse}/${POOL_MAX} חיבורים.`);
}

// סיכום להצגה: מצב עכשיו, שיאים בשעה וב-24 שעות, ושיא לכל שעה (24 עמודות)
export function report() {
  const m = minuteNow();
  const peak = (from) => {
    const r = { inUse: 0, waiting: 0, demo: 0, demoQueue: 0, rejects: 0 };
    for (const [k, b] of buckets) if (k > m - from) {
      for (const f of ['inUse', 'waiting', 'demo', 'demoQueue']) r[f] = Math.max(r[f], b[f]);
      r.rejects += b.rejects;
    }
    return r;
  };
  const hours = [];
  for (let h = 23; h >= 0; h--) {
    const from = m - (h + 1) * 60, to = m - h * 60;
    let inUse = 0, rejects = 0;
    for (let k = from + 1; k <= to; k++) { const b = buckets.get(k); if (b) { inUse = Math.max(inUse, b.inUse); rejects += b.rejects; } }
    hours.push({ end: new Date(to * 60000), inUse, rejects });
  }
  return { now: current(), hour: peak(60), day: peak(DAY), hours, alerts: alerts.slice(0, 10), startedAt, lastAlert: lastAlert ? new Date(lastAlert) : null };
}

pool.on('acquire', () => setImmediate(sample));
setInterval(sample, 2000).unref();
// טעינת ההגדרות מראש (לפני שיהיה עומס)
setTimeout(() => alertSettings().catch(() => {}), 3000).unref();
