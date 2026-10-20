// בר מצווה: התראה X חודשים לפני גיל 13 (לפי התאריך העברי), למקורבים ולבני משפחה שידועה שנת הלידה שלהם.
// בנות (לפי הקרבה: בת, אמא, סבתא, אחות) לא נכללות; "ידוע" (bm_known) מוריד את ההתראה.
import { hebOccurrence, hebDateStr, DAY_NAMES, fmtGreg } from './dates.js';

export const FEMALE = new Set(['בת', 'אמא', 'סבתא', 'אחות']);
// אירוע יום הולדת שהוא בר מצווה (גיל 13, לא בת)
export const isBarMitzvahEvent = (e) => !e.yahrzeit && e.age === 13 && !(e.member && FEMALE.has(e.member.relation));
export const BM_MONTHS = [1, 2, 3, 4, 6, 9, 12];

const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate());

// יום הבר מצווה (יום ההולדת העברי ה-13) של אדם עם שנת לידה עברית ידועה
export function barMitzvahDate(p) {
  if (!p.h_day || !p.h_month || !p.h_year) return null;
  return hebOccurrence(p.h_day, p.h_month, p.h_year + 13);
}

// בר מצוות שחלות מהיום ועד months חודשים קדימה (ולא סומנו "ידוע")
export function upcomingBarMitzvahs({ contacts, family }, today, months) {
  if (!months) return [];
  const until = addMonths(today, months);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const out = [];
  const add = (p, contact, member) => {
    if (p.bm_known) return;
    const date = barMitzvahDate(p);
    if (!date || date < today || date > until) return;
    const h = hebDateStr(p.h_day, p.h_month, p.h_year + 13);
    out.push({ date, contact, member, label: h, days: Math.round((date - today) / 864e5),
      name: member ? member.first_name : [contact.first_name, contact.last_name].filter(Boolean).join(' '),
      sub: member ? `${member.relation} של ${[contact.first_name, contact.last_name].filter(Boolean).join(' ')}` : '' });
  };
  for (const c of contacts) add(c, c, null);
  for (const f of family) {
    if (f.kind === 'yahrzeit' || FEMALE.has(f.relation)) continue;
    const c = byId.get(f.contact_id);
    if (c) add(f, c, f);
  }
  return out.sort((a, b) => a.date - b.date);
}

// "בעוד 4 חודשים" / "בעוד 12 ימים"
export function untilText(days) {
  if (days <= 0) return 'היום!';
  if (days === 1) return 'מחר';
  if (days < 45) return `בעוד ${days} ימים`;
  const m = Math.round(days / 30.4);
  return m === 1 ? 'בעוד כחודש' : `בעוד כ-${m} חודשים`;
}

export function barMitzvahSms(items) {
  const lines = [items.length === 1 ? '🎉 בר מצווה מתקרבת:' : `🎉 ${items.length} בר מצוות מתקרבות:`];
  for (const e of items) lines.push(`${e.name}${e.sub ? ` (${e.sub})` : ''} — ${e.label}, יום ${DAY_NAMES[e.date.getDay()]} ${fmtGreg(e.date)} (${untilText(e.days)})`);
  return lines.join('\n');
}
