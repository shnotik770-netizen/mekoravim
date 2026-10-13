import { q } from './db.js';
import { eventsInRange } from './dates.js';

export async function loadPeople(shliachId) {
  const contacts = (await q('SELECT * FROM contacts WHERE shliach_id=$1 ORDER BY first_name, last_name', [shliachId])).rows;
  const family = (await q(`SELECT f.* FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=$1`, [shliachId])).rows;
  return { contacts, family };
}

// כל ימי ההולדת העבריים (מקורבים + בני משפחה) בטווח
export function collectEvents({ contacts, family }, start, end) {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const out = [];
  for (const c of contacts) {
    for (const e of eventsInRange(c, start, end)) out.push({ ...e, contact: c, member: null, name: `${c.first_name} ${c.last_name}` });
  }
  for (const f of family) {
    const c = byId.get(f.contact_id);
    if (!c) continue;
    for (const e of eventsInRange(f, start, end)) {
      out.push({ ...e, contact: c, member: f, name: f.first_name, sub: `${f.relation} של ${c.first_name} ${c.last_name}` });
    }
  }
  return out.sort((a, b) => a.date - b.date || a.name.localeCompare(b.name, 'he'));
}
