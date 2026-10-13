// חשבון הדגמה בדף הבית: הנתונים נשמרים רק בזיכרון הדפדפן. השרת רק מחשב (תאריכים עבריים, יום ההולדת הבא,
// גיל, שיוך להיום/השבוע/החודש) ולא שומר דבר — לא במסד הנתונים, לא בעוגייה ולא ביומן.
import { HDate } from '@hebcal/core';
import { parseBirth, birthText } from './person.js';
import { todayIL, addDays, toISO, weekRange, hebMonthRange, hebToday, hebFromGreg, nextBirthday, HEB_DAYS, HEB_MONTHS, DAY_NAMES } from './dates.js';

export const DEMO_MAX = 60;

const NAMES = [
  ['מנחם מענדל', 'גרין'], ['חיה מושקא', 'ברגר'], ['יוסי', 'כהן'], ['שרה', 'לוי'], ['דוד', 'אברהמי'],
  ['רבקה', 'פרידמן'], ['אברהם', 'שטרן'], ['לאה', 'רוזן'], ['שמואל', 'כץ'], ['מרים', 'וייס'],
];
// רובם היום / השבוע / החודש (יחסית להיום — מתעדכן), והשאר מפוזרים על פני השנה
const OFFSETS = [0, 0, 1, 3, 6, 10, 16, 75, 160, 250];
const AGES = [34, 27, 52, 41, 13, 66, 38, 22, 45, 9];

export function demoSeed(today = todayIL()) {
  return OFFSETS.map((off, i) => {
    const target = addDays(today, off);
    const h = hebFromGreg(target, false);
    const [first_name, last_name] = NAMES[i];
    const p = { id: `s${i}`, first_name, last_name };
    // אדר / ל׳ בחודש — בלי שנה (נמנעים ממקרי קצה בהדגמה)
    const plain = h.month === 12 || h.month === 13 || h.day === 30;
    const year = plain ? null : h.year - AGES[i];
    if (!plain && i % 3 === 1) {
      // חלק מהמקורבים "מילאו" תאריך לועזי — מראה את ההמרה
      p.date_type = 'g';
      p.g_date = toISO(new HDate(h.day, h.month, year).greg());
    } else {
      Object.assign(p, { date_type: 'h', h_day: String(h.day), h_month: String(h.month), h_year: year ? String(year) : '' });
    }
    return p;
  });
}

// חישוב לכל המקורבים של ההדגמה
export function demoCalc(people, today = todayIL()) {
  const w = weekRange(today), m = hebMonthRange(today), end30 = addDays(today, 29);
  const inR = (d, a, b) => d >= a && d <= b;
  const out = [];
  for (const raw of (Array.isArray(people) ? people : []).slice(0, DEMO_MAX)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').slice(0, 20);
    const first = String(raw.first_name || '').trim().slice(0, 40);
    const last = String(raw.last_name || '').trim().slice(0, 40);
    if (!first) { out.push({ id, error: 'יש להזין שם פרטי' }); continue; }
    const b = parseBirth({ date_type: raw.date_type, g_date: raw.g_date, after_sunset: raw.after_sunset ? '1' : '', h_day: raw.h_day, h_month: raw.h_month, h_year: raw.h_year });
    if (b.error) { out.push({ id, error: b.error }); continue; }
    const p = b.value;
    const next = nextBirthday(p, today);
    const days = next ? Math.round((next.date - today) / 86400000) : null;
    out.push({
      id, name: `${first} ${last}`.trim(), birth: birthText(p),
      next: next && {
        iso: toISO(next.date), label: next.label, note: next.note || '', age: next.age || null, days,
        day: DAY_NAMES[next.date.getDay()], greg: `${next.date.getDate()}.${next.date.getMonth() + 1}`,
      },
      today: !!next && days === 0,
      week: !!next && inR(next.date, w.start, w.end),
      month: !!next && inR(next.date, m.start, m.end),
      next30: !!next && inR(next.date, today, end30),
    });
  }
  out.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || (a.next?.days ?? 999) - (b.next?.days ?? 999));
  return {
    people: out,
    header: { today: `${DAY_NAMES[today.getDay()]}, ${hebToday(today)}`, monthName: m.name.split(' ')[0], week: `${w.start.getDate()}.${w.start.getMonth() + 1}–${w.end.getDate()}.${w.end.getMonth() + 1}` },
  };
}

export const demoOptions = () => ({ days: HEB_DAYS, months: HEB_MONTHS });
