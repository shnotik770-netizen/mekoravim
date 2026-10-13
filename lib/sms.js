// שליחת SMS לשליחים דרך ימות המשיח (call2all): תזכורת שבועית/יומית, מכסה חודשית ויומן שליחות
import { q } from './db.js';
import { loadPeople, collectEvents } from './events.js';
import { todayIL, weekRange, dailyRange, weeklySendDay, upcomingSunday, isRestDay, toISO, DAY_NAMES } from './dates.js';

const API = process.env.YEMOT_API_URL || 'https://www.call2all.co.il/ym/api';
const TOKEN = process.env.YEMOT_TOKEN; // מפתח API של ימות המשיח (apik_...) או "מספר_מערכת:סיסמה"
const FROM = process.env.YEMOT_SMS_FROM; // מזהה שולח מאושר (לא חובה)
const SEND_HOUR = parseInt(process.env.SMS_HOUR || '8', 10); // שעת שליחה (שעון ישראל)
const MAX_LINES = 25;

export const smsConfigured = () => !!TOKEN;
export const FREQUENCIES = { weekly: 'פעם בשבוע (יום ראשון)', daily: 'כל יום' };

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

/* ------------------------------ מכסה ויומן ------------------------------ */

// מספר יחידות SMS: עברית = 70 תווים להודעה אחת, 67 לכל חלק בהודעה מחולקת; לטינית בלבד = 160/153
export function smsUnits(message) {
  const len = [...message].length;
  const unicode = /[^\x00-\x7F]/.test(message);
  const [one, part] = unicode ? [70, 67] : [160, 153];
  return len <= one ? 1 : Math.ceil(len / part);
}

export const DEFAULT_QUOTA_FALLBACK = 100;
export async function getDefaultQuota() {
  const { rows } = await q(`SELECT value FROM app_settings WHERE key='sms_quota_default'`);
  const n = parseInt(rows[0]?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUOTA_FALLBACK;
}
export async function setDefaultQuota(n) {
  await q(`INSERT INTO app_settings (key, value) VALUES ('sms_quota_default', $1)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(n)]);
}

// הודעות שהמנהל שולח (פרטי כניסה) לא נספרות במכסה של השליח
const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'`;
export const USAGE_SQL = `(SELECT coalesce(sum(units),0)::int FROM sms_log l WHERE l.shliach_id=shluchim.id AND l.kind <> 'admin' AND l.created_at >= ${MONTH_START})`;

export async function quotaStatus(shliach) {
  const { rows } = await q(
    `SELECT coalesce(sum(units),0)::int AS used FROM sms_log WHERE shliach_id=$1 AND kind <> 'admin' AND created_at >= ${MONTH_START}`,
    [shliach.id]);
  const quota = shliach.sms_quota ?? (await getDefaultQuota());
  return { used: rows[0].used, quota, left: Math.max(0, quota - rows[0].used) };
}

// שליחה לשליח + רישום ביומן. enforce = לחסום כשהמכסה החודשית לא מספיקה
// (קוד כניסה חד-פעמי נספר אבל לא נחסם, כדי שהשליח לא יינעל מחוץ לחשבון)
export async function sendToShliach(shliach, phone, message, kind, { enforce = true } = {}) {
  const units = smsUnits(message);
  if (enforce) {
    const st = await quotaStatus(shliach);
    if (st.used + units > st.quota) throw new Error(`המכסה החודשית של הודעות SMS נוצלה (${st.used} מתוך ${st.quota} יחידות)`);
  }
  await sendSms(phone, message);
  await q('INSERT INTO sms_log (shliach_id, kind, units) VALUES ($1,$2,$3)', [shliach.id, kind, units]);
  return units;
}

/* ------------------------------ תוכן ההודעות ------------------------------ */

const fmt = (d) => `${d.getDate()}.${d.getMonth() + 1}`;

function buildMessage(title, events, emptyText, link) {
  const lines = [title];
  if (!events.length) lines.push(emptyText);
  for (const e of events.slice(0, MAX_LINES)) {
    const who = e.member ? `${e.member.first_name} (${e.member.relation} של ${e.contact.first_name} ${e.contact.last_name})` : e.name;
    const when = e.note ? `${e.label} (השנה ${e.actualLabel})` : e.label;
    lines.push(`${DAY_NAMES[e.date.getDay()]} ${when}: ${who}${e.age ? `, ${e.age}` : ''}`);
  }
  if (events.length > MAX_LINES) lines.push(`ועוד ${events.length - MAX_LINES}…`);
  if (link) lines.push(link);
  return lines.join('\n');
}

// כל ימי ההולדת השבוע (ראשון–שבת)
export function buildWeeklyMessage(shliachName, events, week, link) {
  return buildMessage(`🎂 ימי הולדת השבוע (${fmt(week.start)}–${fmt(week.end)})`, events, 'אין ימי הולדת השבוע.', link);
}

// ימי ההולדת של היום (ובערב שבת/חג — גם של ימי השבת/החג שאחריו)
export function buildDailyMessage(events, range, link) {
  const single = range.start.getTime() === range.end.getTime();
  const title = single
    ? `🎂 ימי הולדת היום (${DAY_NAMES[range.start.getDay()]} ${fmt(range.start)})`
    : `🎂 ימי הולדת היום ועד מוצאי שבת/חג (${fmt(range.start)}–${fmt(range.end)})`;
  return buildMessage(title, events, single ? 'אין ימי הולדת היום.' : 'אין ימי הולדת בימים אלה.', link);
}

const linkFor = (shliach) => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/s/${shliach.slug}` : '');

// ההודעה לשליח לפי התדירות שבחר. events מוחזר כדי לדעת אם יש בכלל מה לשלוח
export async function reminderFor(shliach, today = todayIL()) {
  const people = await loadPeople(shliach.id);
  if (shliach.sms_frequency === 'daily') {
    const range = dailyRange(today);
    const events = collectEvents(people, range.start, range.end);
    return { kind: 'daily', events, message: buildDailyMessage(events, range, linkFor(shliach)) };
  }
  // שבועי: ביום השליחה — השבוע של יום ראשון הקרוב (כשיום ראשון הוא חג, ההודעה נשלחת לפניו);
  // בשאר הימים (תצוגה מקדימה / ניסיון) — השבוע הנוכחי
  const week = weekRange(isWeeklySendDay(today) ? upcomingSunday(today) : today);
  const events = collectEvents(people, week.start, week.end);
  return { kind: 'weekly', events, message: buildWeeklyMessage(shliach.name, events, week, linkFor(shliach)) };
}

export async function weeklyMessageFor(shliach, today = todayIL()) {
  return (await reminderFor(shliach, today)).message;
}

// שליחה לשליח אחד ושמירת התוצאה. ביומי — בלי ימי הולדת לא שולחים (חוסך מכסה), חוץ מהודעת ניסיון
export async function sendWeekly(shliach, today = todayIL(), { test = false } = {}) {
  const phone = normalizePhone(shliach.sms_phone);
  try {
    if (!phone) throw new Error('מספר הטלפון לקבלת SMS אינו תקין');
    const r = await reminderFor(shliach, today);
    if (!test && r.kind === 'daily' && !r.events.length) return { ok: true, skipped: true };
    await sendToShliach(shliach, phone, r.message, test ? 'test' : r.kind);
    await q('UPDATE shluchim SET sms_last_error=NULL WHERE id=$1', [shliach.id]);
    return { ok: true };
  } catch (err) {
    await q('UPDATE shluchim SET sms_last_error=$1 WHERE id=$2', [String(err.message).slice(0, 300), shliach.id]);
    console.error(`SMS לשליח ${shliach.id} נכשל:`, err.message);
    return { ok: false, error: err.message };
  }
}

export const isWeeklySendDay = (today) => toISO(weeklySendDay(upcomingSunday(today))) === toISO(today);

function hourIL(now) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(now), 10);
}

// ריצה תקופתית: רק ביום חול (לא בשבת ולא ביום טוב), מהשעה שנקבעה, פעם אחת ביום לכל שליח.
// יומי — כל יום חול; שבועי — ביום ראשון, או ביום החול שלפניו כשיום ראשון הוא חג.
export async function runWeeklyTick(now = new Date()) {
  const today = todayIL(now);
  if (!TOKEN || hourIL(now) < SEND_HOUR || isRestDay(today)) return 0;
  const iso = toISO(today);
  const weeklyToday = isWeeklySendDay(today);
  // "תפיסה" אטומית — מונעת שליחה כפולה גם אם רצים כמה מופעים
  const { rows } = await q(
    `UPDATE shluchim SET sms_last_sent=$1
     WHERE active AND sms_enabled AND sms_phone <> '' AND (sms_last_sent IS NULL OR sms_last_sent < $1)
       AND (sms_frequency = 'daily' OR $2)
     RETURNING *`, [iso, weeklyToday]);
  for (const s of rows) await sendWeekly(s, today);
  return rows.length;
}

export function startScheduler() {
  if (!TOKEN) { console.log('SMS: לא מוגדר YEMOT_TOKEN — התזכורות כבויות'); return; }
  const tick = () => runWeeklyTick().catch((e) => console.error('SMS tick:', e));
  setTimeout(tick, 15 * 1000);
  setInterval(tick, 10 * 60 * 1000);
  console.log(`SMS: תזכורות (שבועי/יומי) מהשעה ${SEND_HOUR}:00, לא בשבת וחג`);
}
