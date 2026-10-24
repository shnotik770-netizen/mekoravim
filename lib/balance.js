// יתרת היחידות בחשבון ימות המשיח (GetSession): בדיקה פעם ביום, הצגה בדף המנהל,
// ו-SMS למנהל (לנייד ההתראות של מעקב העומס) כשהיתרה יורדת מתחת לסף — בירידה מתחת לסף, ותזכורת כל 3 ימים.
import { q } from './db.js';
import { audit } from './audit.js';
import { sendSms, normalizePhone, smsConfigured } from './sms.js';
import { alertSettings } from './monitor.js';

const API = process.env.YEMOT_API_URL || 'https://www.call2all.co.il/ym/api';
const TOKEN = process.env.YEMOT_TOKEN;
export const DEFAULT_THRESHOLD = 300;
const REMIND_MS = 3 * 24 * 3600 * 1000;
const KEYS = ['yemot_units', 'yemot_units_at', 'yemot_units_err', 'yemot_threshold', 'yemot_low_at'];

const setKey = (k, v) => q(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);
const delKey = (k) => q('DELETE FROM app_settings WHERE key=$1', [k]);

export async function balanceState() {
  const { rows } = await q('SELECT key, value FROM app_settings WHERE key = ANY($1)', [KEYS]);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const threshold = Number.isFinite(+v.yemot_threshold) && v.yemot_threshold !== undefined ? +v.yemot_threshold : DEFAULT_THRESHOLD;
  const units = v.yemot_units !== undefined ? +v.yemot_units : null;
  return { units, at: v.yemot_units_at ? new Date(v.yemot_units_at) : null, error: v.yemot_units_err || null, threshold,
    low: units !== null && units < threshold, configured: smsConfigured() };
}

export async function saveThreshold(n) {
  await setKey('yemot_threshold', n);
  await delKey('yemot_low_at'); // סף חדש — התראה מחדש אם צריך
}

// התשובה של GetSession כוללת את יתרת היחידות (בפורום: units / customerUnits)
async function fetchUnits() {
  let res;
  try {
    res = await fetch(`${API}/GetSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }), signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('בעיית תקשורת עם ימות המשיח'); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`תשובה לא צפויה מימות המשיח (${res.status})`); }
  if (!res.ok || data.responseStatus !== 'OK') throw new Error(data.message || data.responseStatus || 'הבדיקה נכשלה');
  for (const k of ['units', 'customerUnits', 'Units']) {
    const n = Number(data[k]);
    if (data[k] !== undefined && data[k] !== '' && Number.isFinite(n)) return Math.floor(n);
  }
  // בלי ערכים — רק שמות השדות, לאבחון
  throw new Error(`לא נמצא שדה יחידות בתשובה (שדות: ${Object.keys(data).join(', ').slice(0, 200)})`);
}

export async function checkBalance() {
  if (!TOKEN) throw new Error('SMS לא מוגדר (חסר YEMOT_TOKEN)');
  await setKey('yemot_units_at', new Date().toISOString());
  let units;
  try {
    units = await fetchUnits();
  } catch (e) {
    await setKey('yemot_units_err', e.message);
    audit({ actor: 'system', action: 'בדיקת יתרה בימות המשיח', outcome: 'error', detail: e.message });
    throw e;
  }
  await setKey('yemot_units', units);
  await delKey('yemot_units_err');
  const st = await balanceState();
  if (!st.low) { await delKey('yemot_low_at'); return st; }
  const { rows: [r] } = await q(`SELECT value FROM app_settings WHERE key='yemot_low_at'`);
  if (r && Date.now() - new Date(r.value) < REMIND_MS) return st;
  await setKey('yemot_low_at', new Date().toISOString());
  const text = `זכרתי התקשרתי — יתרת היחידות בימות המשיח נמוכה: ${units} יחידות (סף ההתראה: ${st.threshold}). כדאי לטעון יחידות כדי שהתזכורות ימשיכו להישלח.`;
  const to = normalizePhone((await alertSettings()).phone);
  let error = to ? null : 'לא הוגדר נייד להתראות';
  if (to) { try { await sendSms(to, text); } catch (e) { error = e.message; } }
  audit({ actor: 'system', action: 'התראת יתרה נמוכה בימות המשיח', outcome: error ? 'fail' : 'ok', detail: `${units} יחידות${error ? ` — ${error}` : ''}` });
  return st;
}

// פעם ביום: בודקים כל שעה אם עברו 23 שעות מהבדיקה האחרונה (עמיד להפעלות מחדש של השרת)
async function tick() {
  if (!TOKEN) return;
  const { rowCount } = await q(`UPDATE app_settings SET value=now()::text WHERE key='yemot_units_at' AND value::timestamptz < now() - interval '23 hours'`);
  const { rows } = await q(`SELECT 1 FROM app_settings WHERE key='yemot_units_at'`);
  if (!rowCount && rows.length) return;
  await checkBalance();
}
export function startBalanceChecks() {
  const run = () => tick().catch((e) => console.error('balance:', e.message));
  setTimeout(run, 20000).unref();
  setInterval(run, 3600 * 1000).unref();
}
