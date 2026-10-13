// חשבון הדגמה (/demo): בכל בקשה נוצר שליח לדוגמה בתוך טרנזקציה שמבוטלת בסוף הבקשה (ראו server.js),
// כך שהמסכים אמיתיים לגמרי אבל שום דבר לא נשמר — לא מקורבים, לא הגדרות, לא יומן ולא SMS.
import { HDate } from '@hebcal/core';
import { q } from './db.js';
import { parseBirth } from './person.js';
import { todayIL, addDays, toISO, hebFromGreg } from './dates.js';

const NAMES = [
  ['מנחם מענדל', 'גרין'], ['חיה מושקא', 'ברגר'], ['יוסי', 'כהן'], ['שרה', 'לוי'], ['דוד', 'אברהמי'],
  ['רבקה', 'פרידמן'], ['אברהם', 'שטרן'], ['לאה', 'רוזן'], ['שמואל', 'כץ'], ['מרים', 'וייס'],
];
// רובם היום / השבוע / החודש (יחסית להיום — מתעדכן), והשאר מפוזרים על פני השנה
const OFFSETS = [0, 0, 1, 3, 6, 10, 16, 75, 160, 250];
const AGES = [34, 27, 52, 41, 13, 66, 38, 22, 45, 9];

// מקורבים לדוגמה כשדות טופס (date_type + תאריך עברי או לועזי)
export function demoSeed(today = todayIL()) {
  return OFFSETS.map((off, i) => {
    const h = hebFromGreg(addDays(today, off), false);
    const [first_name, last_name] = NAMES[i];
    const p = { first_name, last_name };
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

// בני משפחה לדוגמה: [אינדקס מקורב, קשר, שם, היסט ימים מהיום, גיל]
const FAMILY = [[2, 'בת', 'נועה', 2, 8], [2, 'בן/בת זוג', 'רחל', 40, 50], [4, 'בן', 'מאיר', 12, 3], [6, 'אמא', 'גולדה', 5, 70]];

// יוצר את חשבון ההדגמה (בתוך הטרנזקציה של הבקשה) ומחזיר את ה-slug.
// מזהים קבועים ושליליים: כך קישורים בין מסכים (כרטיס מקורב, קישור רישום) עובדים גם כשהנתונים נוצרים
// מחדש בכל בקשה, ואין התנגשות עם נתונים אמיתיים (מספרים חיוביים מה-SERIAL).
export const DEMO_SLUG = 'demo-account';
export async function seedDemoAccount(categoriesSeed, colors, today = todayIL()) {
  const SID = -1;
  await q(
    `INSERT INTO shluchim (id, name, chabad_house, slug, phone, sms_phone, sms_weekly, sms_daily, sms_enabled, sms_quota, sms_used_birthdays, sms_last_sent, login_mode)
     VALUES ($1, 'הרב יוסי אברהמי', 'בית חב״ד לדוגמה', $2, '0500000000', '0500000000', TRUE, FALSE, TRUE, 100, 14, $3, 'code')`,
    [SID, DEMO_SLUG, toISO(addDays(today, -today.getDay()))]);
  const cats = categoriesSeed.map((_, i) => -(i + 1));
  for (const [i, [n, c]] of categoriesSeed.entries()) {
    await q('INSERT INTO categories (id, shliach_id, name, color, sort) VALUES ($1,$2,$3,$4,$5)', [cats[i], SID, n, c || colors[i % colors.length], i]);
  }
  const links = [-1, -2];
  for (const [i, name] of ['שיעור תניא — יום ג׳', 'אירוע ל"ג בעומר'].entries()) {
    await q('INSERT INTO reg_links (id, shliach_id, token, name, category_id) VALUES ($1,$2,$3,$4,$5)',
      [links[i], SID, `demo-link-${i + 1}`, name, cats[i % cats.length]]);
  }
  const ids = [];
  for (const [i, p] of demoSeed(today).entries()) {
    const b = parseBirth(p).value;
    const id = -(i + 1);
    await q(
      `INSERT INTO contacts (id, shliach_id, first_name, last_name, phone, notes, g_date, g_after_sunset, h_day, h_month, h_year, category_id, reg_link_id, remind_days, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() - make_interval(days => $15))`,
      [id, SID, p.first_name, p.last_name, i === 9 ? '' : `050-00000${String(i).padStart(2, '0')}`, i === 0 ? 'מגיע לשיעור כל שבוע' : '',
        b.g_date, b.g_after_sunset, b.h_day, b.h_month, b.h_year, cats[i % cats.length], i % 4 === 1 ? links[i % 2] : null,
        i === 2 ? 2 : null, 5 + i * 9]);
    ids.push(id);
  }
  for (const [k, [ci, relation, first, off, age]] of FAMILY.entries()) {
    const h = hebFromGreg(addDays(today, off), false);
    const plain = h.month === 12 || h.month === 13 || h.day === 30;
    await q('INSERT INTO family_members (id, contact_id, relation, first_name, h_day, h_month, h_year) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [-(k + 1), ids[ci], relation, first, h.day, h.month, plain ? null : h.year - age]);
  }
  // "יצרתי קשר" עם אחד מבעלי השמחה של היום
  await q('INSERT INTO contact_log (contact_id, note) VALUES ($1, $2)', [ids[1], 'התקשרתי לאחל מזל טוב']);
  return DEMO_SLUG;
}
