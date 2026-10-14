// פנייה לשליח / לשלוחה: תואר (הרב / הרבנית) ולשון זכר / נקבה
export const ADDRESS_OPTIONS = [
  ['m1', 'הרב (שליח)'], ['f1', 'הרבנית (שלוחה)'], ['m0', 'שליח — בלי תואר'], ['f0', 'שלוחה — בלי תואר'],
];
export const addressKey = (s) => `${s?.gender === 'f' ? 'f' : 'm'}${s?.use_title === false ? 0 : 1}`;
export function parseAddress(v) {
  const k = ADDRESS_OPTIONS.some(([key]) => key === v) ? v : 'm1';
  return { gender: k[0], use_title: k[1] === '1' };
}
const HAS_TITLE = /^(הרב|הרבנית|הרה"ג|הרה״ג|רבי|ר['׳]|הגה"צ)\s/;
// השם לפנייה: "הרבנית חיה כהן" (בלי להכפיל תואר שכבר כתוב בשם)
export function displayName(s) {
  const name = String(s?.name || '').trim();
  if (s?.use_title === false || HAS_TITLE.test(name)) return name;
  return `${s?.gender === 'f' ? 'הרבנית' : 'הרב'} ${name}`;
}
// בחירת מילה לפי המין: g(s, 'משתמש', 'משתמשת')
export const g = (s, m, f) => (s?.gender === 'f' ? f : m);
