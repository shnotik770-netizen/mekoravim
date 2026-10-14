// לוגיקת תאריכים: המרה לועזי⇄עברי וחישוב ימי הולדת בטווח תאריכים.
// כל אובייקטי Date כאן הם "חצות מקומית" (ללא שעה), ו"היום" מחושב לפי שעון ישראל.
import { HDate, HebrewCalendar, flags, gematriya, gematriyaStrToNum, getSedra, Locale } from '@hebcal/core';

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

// היום הלועזי שבו מציינים את יום ההולדת העברי בשנה העברית hyear.
// ל׳ בחודש שהשנה יש בו רק 29 ימים — מציינים יום קודם (כ״ט באותו חודש).
export function hebOccurrence(day, month, hyear) {
  let m = month;
  if ((m === 12 || m === 13) && !HDate.isLeapYear(hyear)) m = 12;
  const first = new HDate(1, m, hyear);
  return new HDate(first.abs() + Math.min(day, first.daysInMonth()) - 1).greg();
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
  // כל השנים העבריות שבטווח (טווח ארוך יכול לגעת בשלוש שנים)
  const y0 = new HDate(start).getFullYear(), y1 = new HDate(end).getFullYear();
  for (let hy = y0; hy <= y1; hy++) {
    const d = hebOccurrence(p.h_day, p.h_month, hy);
    const age = p.h_year ? hy - p.h_year : null;
    if (d >= start && d <= end && (age === null || age > 0)) {
      out.push({ date: d, age, hyear: hy, ...occurrenceLabel(p, d, hy) });
    }
  }
  return out;
}

// התווית היא תמיד תאריך הלידה המקורי (למשל "ל׳ חשוון"). כשהשנה מציינים בתאריך אחר
// (ל׳ בחודש חסר → כ״ט; אדר א׳ בשנה פשוטה → אדר; אדר בשנה מעוברת → אדר ב׳)
// note מסבירה באיזה תאריך מציינים השנה.
export function occurrenceLabel(p, d, hy) {
  const birth = p.h_year ? hebDateStr(p.h_day, p.h_month, p.h_year).replace(/ \S+$/, '') : hebDateStr(p.h_day, p.h_month, null);
  const actual = hebFromGreg(d, false);
  const actualLabel = hebDateStr(actual.day, actual.month, actual.year).replace(/ \S+$/, '');
  const leap = HDate.isLeapYear(hy);
  let note = null;
  if (actual.day !== p.h_day) {
    note = p.h_month === 12 && !leap
      ? `בשנה פשוטה אין אדר א׳ — השנה מציינים ב${actualLabel}`
      : `השנה אין ${birth} — מציינים ב${actualLabel}`;
  } else if (p.h_month === 12 && !leap) {
    note = `בשנה פשוטה אין אדר א׳ — השנה מציינים ב${actualLabel}`;
  } else if (p.h_month === 13 && leap && !(p.h_year && HDate.isLeapYear(p.h_year))) {
    note = `בשנה מעוברת מציינים ב${actualLabel}`;
  }
  return { label: birth, actualLabel, note };
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

// טווח בתאריך עברי, למשל "ג׳–ט׳ חשוון" / "כ״ח תשרי–ה׳ חשוון" (שנה רק כשהטווח חוצה שנה)
export function hebRangeStr(start, end) {
  const a = hebFromGreg(start, false), b = hebFromGreg(end, false);
  if (+start === +end) return hebDateStr(a.day, a.month, a.year);
  const ys = a.year !== b.year;
  const yr = (h) => (ys ? ` ${gematriya(h.year % 1000)}` : '');
  const left = a.month === b.month && !ys ? gematriya(a.day) : `${gematriya(a.day)} ${monthName(a.month, a.year)}${yr(a)}`;
  return `${left}–${gematriya(b.day)} ${monthName(b.month, b.year)}${yr(b)}`;
}

export function hebToday(today) {
  const h = hebFromGreg(today, false);
  return hebDateStr(h.day, h.month, h.year);
}

// שבת או יום טוב (לוח ארץ ישראל) — ימים שלא שולחים בהם SMS
export function isRestDay(d) {
  if (d.getDay() === 6) return true;
  const evs = HebrewCalendar.getHolidaysOnDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12), true) || [];
  return evs.some((e) => e.getFlags() & flags.CHAG);
}

// שליחה יומית: ביום חול שולחים את ימי ההולדת של היום ושל כל ימי השבת/החג שמיד אחריו
export function dailyRange(today) {
  let end = today;
  while (isRestDay(addDays(end, 1))) end = addDays(end, 1);
  return { start: today, end };
}

// שליחה שבועית: ביום ראשון, ואם הוא חג — ביום החול האחרון שלפניו
export function weeklySendDay(sunday) {
  let d = sunday;
  while (isRestDay(d)) d = addDays(d, -1);
  return d;
}

// יום ראשון הקרוב (היום, אם היום יום ראשון)
export function upcomingSunday(today) {
  return addDays(today, (7 - today.getDay()) % 7);
}

// שבוע (ראשון–שבת): טווח התאריכים העבריים ופרשת השבוע — לפי לוח ארץ ישראל (il=true)
const noNikud = (t) => t.replace(/[\u0591-\u05C7]/g, '');
export function weekInfo(today) {
  const { start, end } = weekRange(today);
  const heb = hebRangeStr(start, end);
  const hd = new HDate(end); // השבת של השבוע
  const sedra = getSedra(hd.getFullYear(), true).lookup(hd);
  const name = noNikud(sedra.parsha.map((p) => Locale.gettext(p, 'he')).join('-'));
  return { heb, parsha: sedra.chag ? `שבת ${name.replace(/^שבת /, '')}` : `פרשת ${name}` };
}

// הסבר קצר לתאריך לידה שלא חל באותו תאריך בכל שנה (ל׳ חשוון / ל׳ כסלו / אדר א׳ / אדר ב׳) — לתצוגה בטופס.
// מחזיר null כשיום ההולדת קבוע.
export function birthNote(day, month, year) {
  const mName = monthName(month, year);
  if (month === 12) {
    // אדר א׳ (בשנה מעוברת). בשנה רגילה יש רק אדר; ל׳ אדר א׳ → כ״ט אדר
    return day === 30
      ? 'בשנה מעוברת התזכורת תגיע בל׳ אדר א׳, ובשנה רגילה — בכ״ט אדר'
      : `בשנה מעוברת התזכורת תגיע ב${hebDateStr(day, 12, null)}, ובשנה רגילה — ב${gematriya(day)} אדר`;
  }
  if (month === 13) {
    return year && HDate.isLeapYear(year)
      ? `נולד/ה באדר ב׳ — בשנה מעוברת התזכורת תגיע ב${gematriya(day)} אדר ב׳, ובשנה רגילה — ב${gematriya(day)} אדר`
      : `בשנה רגילה התזכורת תגיע ב${gematriya(day)} אדר, ובשנה מעוברת — ב${gematriya(day)} אדר ב׳`;
  }
  if (day === 30 && (month === 8 || month === 9)) {
    return `ל׳ ${mName} לא קיים בכל שנה — בשנים שבהן ${mName} חסר (29 יום), התזכורת ויום ההולדת יגיעו בכ״ט ${mName}`;
  }
  return null;
}
