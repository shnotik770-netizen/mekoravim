// לוגיקת תאריכים: המרה לועזי⇄עברי וחישוב ימי הולדת בטווח תאריכים.
// כל אובייקטי Date כאן הם "חצות מקומית" (ללא שעה), ו"היום" מחושב לפי שעון ישראל.
import { HDate, gematriya, gematriyaStrToNum } from '@hebcal/core';

// בשמירה: 12 = אדר א׳ (רק בשנה מעוברת), 13 = אדר רגיל / אדר ב׳
export const HEB_MONTHS = [
  { v: 7, n: 'תשרי' }, { v: 8, n: 'חשוון' }, { v: 9, n: 'כסלו' }, { v: 10, n: 'טבת' },
  { v: 11, n: 'שבט' }, { v: 12, n: 'אדר א׳ (שנה מעוברת)' }, { v: 13, n: 'אדר / אדר ב׳' },
  { v: 1, n: 'ניסן' }, { v: 2, n: 'אייר' }, { v: 3, n: 'סיוון' }, { v: 4, n: 'תמוז' },
  { v: 5, n: 'אב' }, { v: 6, n: 'אלול' },
];
const NAMES = { 1: 'ניסן', 2: 'אייר', 3: 'סיוון', 4: 'תמוז', 5: 'אב', 6: 'אלול', 7: 'תשרי', 8: 'חשוון', 9: 'כסלו', 10: 'טבת', 11: 'שבט' };

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function monthName(m, year) {
  if (m === 12) return year && !HDate.isLeapYear(year) ? 'אדר' : 'אדר א׳';
  if (m === 13) return year && HDate.isLeapYear(year) ? 'אדר ב׳' : 'אדר';
  return NAMES[m];
}

export function hebDateStr(day, month, year) {
  if (!day || !month) return '';
  let s = `${gematriya(day)} ${monthName(month, year)}`;
  if (year) s += ` ${gematriya(year % 1000)}`;
  return s;
}

export function todayIL() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parseISO(parts);
}

export function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

export function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function fmtGreg(d) {
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

// תאריך עברי מתוך תאריך לועזי (כולל תיקון "נולד אחרי השקיעה")
export function hebFromGreg(gdate, afterSunset) {
  let hd = new HDate(gdate);
  if (afterSunset) hd = hd.next();
  let month = hd.getMonth();
  if (month === 12 && !hd.isLeapYear()) month = 13; // אדר בשנה פשוטה
  return { day: hd.getDate(), month, year: hd.getFullYear() };
}

// היום הלועזי שבו חל יום ההולדת העברי בשנה העברית hyear
export function hebOccurrence(day, month, hyear) {
  let m = month;
  if ((m === 12 || m === 13) && !HDate.isLeapYear(hyear)) m = 12;
  // יום 30 בחודש חסר "מתגלגל" ל-א׳ בחודש הבא
  return new HDate(new HDate(1, m, hyear).abs() + day - 1).greg();
}

function gregOccurrence(gdate, year) {
  let m = gdate.getMonth(), d = gdate.getDate();
  if (m === 1 && d === 29 && new Date(year, 1, 29).getMonth() !== 1) d = 28;
  return new Date(year, m, d);
}

// p: { g_date: 'YYYY-MM-DD'|null, h_day, h_month, h_year }
// mode: 'both' | 'hebrew' | 'gregorian'
export function eventsInRange(p, start, end, mode = 'both') {
  const out = [];
  const inRange = (d) => d >= start && d <= end;
  if (mode !== 'gregorian' && p.h_day && p.h_month) {
    const years = new Set([new HDate(start).getFullYear(), new HDate(end).getFullYear()]);
    for (const hy of years) {
      const d = hebOccurrence(p.h_day, p.h_month, hy);
      const age = p.h_year ? hy - p.h_year : null;
      if (inRange(d) && (age === null || age > 0)) {
        out.push({ date: d, kind: 'hebrew', age, label: hebDateStr(p.h_day, p.h_month, hy).replace(/ \S+$/, '') });
      }
    }
  }
  const g = p.g_date ? parseISO(p.g_date) : null;
  if (mode !== 'hebrew' && g) {
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
      const d = gregOccurrence(g, y);
      const age = y - g.getFullYear();
      if (inRange(d) && age > 0) out.push({ date: d, kind: 'gregorian', age, label: `${d.getDate()}.${d.getMonth() + 1}` });
    }
  }
  return out;
}

export function nextEvents(p, today, mode = 'both') {
  const evs = eventsInRange(p, today, addDays(today, 400), mode).sort((a, b) => a.date - b.date);
  const res = {};
  for (const e of evs) if (!res[e.kind]) res[e.kind] = e;
  return res;
}

// שנה עברית: מספר (5750 / 750) או אותיות (תש"נ / ה׳תש״נ)
export function parseHebYear(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let n = /^\d+$/.test(s) ? parseInt(s, 10) : gematriyaStrToNum(s.replace(/^ה['׳]?/, ''));
  if (!n || Number.isNaN(n)) return NaN;
  if (n < 1000) n += 5000;
  return n >= 5600 && n <= 6000 ? n : NaN;
}

export function hebYearStr(y) {
  return y ? gematriya(y % 1000) : '';
}

// שבוע נוכחי (ראשון–שבת) וחודש לועזי נוכחי
export function weekRange(today) {
  const start = addDays(today, -today.getDay());
  return { start, end: addDays(start, 6) };
}
export function monthRange(today) {
  return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: new Date(today.getFullYear(), today.getMonth() + 1, 0) };
}
