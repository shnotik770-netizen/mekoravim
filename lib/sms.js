// שליחת SMS שבועי לשליחים דרך ימות המשיח (call2all)
import { q } from './db.js';
import { loadPeople, collectEvents } from './events.js';
import { todayIL, weekRange, toISO, DAY_NAMES } from './dates.js';

const API = process.env.YEMOT_API_URL || 'https://www.call2all.co.il/ym/api';
const TOKEN = process.env.YEMOT_TOKEN; // מפתח API של ימות המשיח (apik_...) או "מספר_מערכת:סיסמה"
const FROM = process.env.YEMOT_SMS_FROM; // מזהה שולח מאושר (לא חובה)
const SEND_HOUR = parseInt(process.env.SMS_HOUR || '8', 10); // שעת שליחה ביום ראשון (שעון ישראל)
const MAX_LINES = 25;

export const smsConfigured = () => !!TOKEN;

// 0521234567 / 052-123-4567 / +972521234567 → 0521234567
export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^05\d{8}$/.test(d) ? d : null;
}

// לפי הקוד שעובד בפועל בפרויקט הכפרות (ראו סקיל yemot-hamashiach-api): POST עם JSON,
// ו-responseStatus=OK עדיין יכול להכיל כישלון פר-מספר בשדה errors.
export async function sendSms(phone, message) {
  if (!TOKEN) throw new Error('SMS לא מוגדר (חסר YEMOT_TOKEN)');
  const body = { token: TOKEN, phones: phone, message };
  if (FROM) body.from = FROM;
  let res;
  try {
    res = await fetch(`${API}/SendSms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('בעיית תקשורת עם ימות המשיח');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`תשובה לא צפויה מימות המשיח (${res.status})`); }
  if (!res.ok || data.responseStatus !== 'OK') throw new Error(data.message || data.responseStatus || 'שליחה נכשלה');
  const failed = Object.values(data.errors || {});
  if (failed.length) throw new Error(String(failed[0]));
  return data;
}

// תוכן ההודעה: כל ימי ההולדת השבוע (ראשון–שבת)
export function buildWeeklyMessage(shliachName, events, week, link) {
  const fmt = (d) => `${d.getDate()}.${d.getMonth() + 1}`;
  const lines = [`🎂 ימי הולדת השבוע (${fmt(week.start)}–${fmt(week.end)})`];
  if (!events.length) lines.push('אין ימי הולדת השבוע.');
  for (const e of events.slice(0, MAX_LINES)) {
    const who = e.member ? `${e.member.first_name} (${e.member.relation} של ${e.contact.first_name} ${e.contact.last_name})` : e.name;
    lines.push(`${DAY_NAMES[e.date.getDay()]} ${e.label}: ${who}${e.age ? `, ${e.age}` : ''}`);
  }
  if (events.length > MAX_LINES) lines.push(`ועוד ${events.length - MAX_LINES}…`);
  if (link) lines.push(link);
  return lines.join('\n');
}

export async function weeklyMessageFor(shliach, today = todayIL()) {
  const week = weekRange(today);
  const events = collectEvents(await loadPeople(shliach.id), week.start, week.end);
  const link = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/s/${shliach.slug}` : '';
  return buildWeeklyMessage(shliach.name, events, week, link);
}

// שליחה לשליח אחד ושמירת התוצאה
export async function sendWeekly(shliach, today = todayIL()) {
  const phone = normalizePhone(shliach.sms_phone);
  try {
    if (!phone) throw new Error('מספר הטלפון לקבלת SMS אינו תקין');
    await sendSms(phone, await weeklyMessageFor(shliach, today));
    await q('UPDATE shluchim SET sms_last_error=NULL WHERE id=$1', [shliach.id]);
    return { ok: true };
  } catch (err) {
    await q('UPDATE shluchim SET sms_last_error=$1 WHERE id=$2', [String(err.message).slice(0, 300), shliach.id]);
    console.error(`SMS לשליח ${shliach.id} נכשל:`, err.message);
    return { ok: false, error: err.message };
  }
}

function hourIL(now) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(now), 10);
}

// ריצה תקופתית: ביום ראשון, מהשעה שנקבעה, פעם אחת לכל שליח
export async function runWeeklyTick(now = new Date()) {
  const today = todayIL(now);
  if (today.getDay() !== 0 || hourIL(now) < SEND_HOUR || !TOKEN) return 0;
  const iso = toISO(today);
  // "תפיסה" אטומית — מונעת שליחה כפולה גם אם רצים כמה מופעים
  const { rows } = await q(
    `UPDATE shluchim SET sms_last_sent=$1
     WHERE active AND sms_enabled AND sms_phone <> '' AND (sms_last_sent IS NULL OR sms_last_sent < $1)
     RETURNING *`, [iso]);
  for (const s of rows) await sendWeekly(s, today);
  return rows.length;
}

export function startScheduler() {
  if (!TOKEN) { console.log('SMS: לא מוגדר YEMOT_TOKEN — השליחה השבועית כבויה'); return; }
  const tick = () => runWeeklyTick().catch((e) => console.error('SMS tick:', e));
  setTimeout(tick, 15 * 1000);
  setInterval(tick, 10 * 60 * 1000);
  console.log(`SMS: שליחה שבועית בימי ראשון מהשעה ${SEND_HOUR}:00`);
}
