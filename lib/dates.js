// לוגיקת תאריכים: המרה לועזי⇄עברי וחישוב ימי הולדת בטווח תאריכים.
// כל אובייקטי Date כאן הם "חצות מקומית" (ללא שעה), ו"היום" מחושב לפי שעון ישראל.
import { HDate, gematriya, gematriyaStrToNum } from '@hebcal/core';

// בשמירה: 12 = אדר א׳ (רק בשנה מעוברת), 13 = אדר רגיל / אדר ב׳
export const HEB_DAYS = Array.from({ length: 30 }, (_, i) => ({ v: i + 1, n: gematriya(i + 1) }));

export const HEB_MONTHS = [
  { v: 7, n: 'תשרי' }, { v: 8, n: 'חשוון' }, { v: 9, n: 'כסלו' }, { v: 10, n: 'טבת' },
  { v: 11, n: 'שבט' }, { v: 13, n: 'אדר / אדר ב׳' }, { v: 12, n: 'אדר א׳ (בשנה מעוברת)' },
  { v: 1, n: 'ניסן' }, { v: 2, n: 'אייר' }, { v: 3, n: 'סיוון' }, { v: 4, n: 'תמוז' },
  { v: 5, n: 'אב' }, { v: 6, n: 'אלול' },
];
const NAMES = { 1: 'ניסן', 2: 'אייר', 3: 'סיוון', 4: 'תמוז', 5: 'אב', 6: 'אלול', 7: 'תשרי', 8: 'חשוון', 9: 'כסלו', 10: 'טבת', 11: 'שבט' };

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function monthName(m, year) {
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

export function todayIL(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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

// הימים בחודש עברי בשנה מסוימת (לפי שיטת השמירה שלנו: 12=אדר א׳, 13=אדר/אדר ב׳)
export function daysInMonth(month, hyear) {
  let m = month;
  if ((m === 12 || m === 13) && !HDate.isLeapYear(hyear)) m = 12;
  return new HDate(1, m, hyear).daysInMonth();
}

// חודשים שתמיד 29 יום (אין בהם אף פעם ל׳)
const ALWAYS_29 = new Set([2, 4, 6, 10, 13]);

// אימות ונרמול תאריך עברי (כללים כמו בפרויקט קאפיטל)
// מחזיר { value: {day, month, year} } או { error }
export function normalizeHeb(day, month, year) {
  if (!(day >= 1 && day <= 30) || !(month >= 1 && month <= 13)) return { error: 'יש לבחור יום וחודש עבריים' };
  if (year) {
    const leap = HDate.isLeapYear(year);
    if (!leap && month === 12) month = 13; // "אדר א׳" בשנה פשוטה = אדר
    if (day === 30 && month === 13 && leap) month = 12; // ל׳ אדר בשנה מעוברת = ל׳ אדר א׳
    if (day > daysInMonth(month, year)) {
      return { error: ALWAYS_29.has(month) && month !== 13
        ? `אין תאריך כזה — בחודש ${monthName(month, year)} אין אף פעם ל׳`
        : `אין ל׳ ${monthName(month, year)} בשנת ${gematriya(year % 1000)} — היו בחודש רק 29 ימים` };
    }
  } else {
    if (day === 30 && month === 13) month = 12; // "ל׳ אדר" קיים רק באדר א׳
    else if (day === 30 && ALWAYS_29.has(month)) return { error: `אין תאריך כזה — בחודש ${monthName(month)} אין אף פעם ל׳` };
  }
  return { value: { day, month, year: year || null } };
}

// האם יום ההולדת "נודד" (ל׳ בחודש שאורכו משתנה) — לאזהרה בלבד
export function isRolloverDay(day, month) {
  return day === 30 && (month === 8 || month === 9 || month === 12);
}

// ימי הולדת עבריים שחלים בטווח. p: { h_day, h_month, h_year }
export function eventsInRange(p, start, end) {
  const out = [];
  if (!p.h_day || !p.h_month) return out;
  const years = new Set([new HDate(start).getFullYear(), new HDate(end).getFullYear()]);
  for (const hy of years) {
    const d = hebOccurrence(p.h_day, p.h_month, hy);
    const age = p.h_year ? hy - p.h_year : null;
    if (d >= start && d <= end && (age === null || age > 0)) {
      out.push({ date: d, age, label: hebDateStr(p.h_day, p.h_month, hy).replace(/ \S+$/, ''), hyear: hy });
    }
  }
  return out;
}

export function nextBirthday(p, today) {
  return eventsInRange(p, today, addDays(today, 400)).sort((a, b) => a.date - b.date)[0] || null;
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
// החודש העברי הנוכחי
export function hebMonthRange(today) {
  const hd = new HDate(today);
  const first = new HDate(1, hd.getMonth(), hd.getFullYear());
  const start = first.greg();
  const end = addDays(start, first.daysInMonth() - 1);
  let m = hd.getMonth();
  if (m === 12 && !hd.isLeapYear()) m = 13;
  return { start, end, name: `${monthName(m, hd.getFullYear())} ${gematriya(hd.getFullYear() % 1000)}` };
}

export function hebToday(today) {
  const h = hebFromGreg(today, false);
  return hebDateStr(h.day, h.month, h.year);
}
