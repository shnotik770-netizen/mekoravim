// החלפת תאריך עברי/לועזי (רכיב bd-toggle)
function bindDatebox(box) {
  const sync = () => {
    const h = box.querySelector('input[type=radio][value=h]').checked;
    box.querySelector('.g-fields').hidden = h;
    box.querySelector('.h-fields').hidden = !h;
  };
  box.querySelectorAll('input[type=radio]').forEach((r) => r.addEventListener('change', sync));
  sync();
  bindHebPreview(box);
}

// תצוגה מקדימה: התאריך העברי מיד בהזנה, והסבר כשיום ההולדת לא חל באותו תאריך כל שנה
function bindHebPreview(box) {
  const out = box.querySelector('[data-heb-preview]');
  if (!out) return;
  const field = (k) => box.querySelector(`[name="${k}"], [name$="[${k}]"]`);
  let timer, seq = 0;
  const show = (html, cls) => { out.className = 'bd-heb-preview' + (cls ? ' ' + cls : ''); out.innerHTML = html; out.hidden = !html; };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const update = async () => {
    const g = box.querySelector('input[type=radio][value=g]').checked;
    const p = new URLSearchParams({ date_type: g ? 'g' : 'h' });
    if (g) {
      const d = field('g_date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return show('');
      p.set('g_date', d);
      if (field('after_sunset').checked) p.set('after_sunset', '1');
    } else {
      const day = field('h_day').value, month = field('h_month').value;
      if (!day || !month) return show('');
      p.set('h_day', day); p.set('h_month', month); p.set('h_year', field('h_year').value);
    }
    const my = ++seq;
    try {
      const r = await (await fetch('/api/hebdate?' + p, { headers: { Accept: 'application/json' } })).json();
      if (my !== seq) return;
      if (r.error) return show(`<span>⚠️ ${esc(r.error)}</span>`, 'bd-heb-preview--bad');
      let html = g ? `<span class="bd-heb-preview__date">📅 בתאריך עברי: <b>${esc(r.label)}</b></span>` : '';
      if (r.next) html += `<span class="bd-heb-preview__next">${r.next.today ? '🎂 יום ההולדת היום!' : `יום ההולדת הבא: יום ${esc(r.next.day)}, ${esc(r.next.label)} · <bdi class="bd-num">${esc(r.next.greg)}</bdi>`}${r.next.age ? ` · גיל ${r.next.age}` : ''}</span>`;
      if (r.note) html += `<span class="bd-heb-preview__note">💡 ${esc(r.note)}</span>`;
      show(html, r.note ? 'bd-heb-preview--note' : '');
    } catch { show(''); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 250); };
  box.addEventListener('input', later);
  box.addEventListener('change', later);
  update();
}
document.querySelectorAll('.datebox').forEach(bindDatebox);

// הוספת/הסרת בני משפחה בטופס
const list = document.getElementById('fam-list');
const tpl = document.getElementById('fam-tpl');
const addBtn = document.getElementById('add-fam');
if (list && tpl && addBtn) {
  let idx = list.children.length + 100;
  addBtn.addEventListener('click', () => {
    const html = tpl.innerHTML.replaceAll('__I__', String(idx++));
    list.insertAdjacentHTML('beforeend', html);
    const row = list.lastElementChild;
    bindDatebox(row.querySelector('.datebox'));
    row.querySelector('input[name$="[first_name]"]').focus();
  });
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) e.target.closest('.fam-row').remove();
  });
}

// אישור לפני פעולות
document.querySelectorAll('form[data-confirm]').forEach((f) =>
  f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));

// העתקה בלחיצה
document.querySelectorAll('code.copy').forEach((el) => {
  el.title = 'לחצו להעתקה';
  el.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.textContent.trim()); el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200); } catch {}
  });
});

// שליחה אוטומטית של טופס בשינוי בחירה (במקום onchange inline — חסום ב-CSP)
document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

// "שמירה כאפליקציה" (PWA) — כמו בקאפיטל: רישום service worker, שמירת אירוע ההתקנה
// והפעלתו רק בלחיצה. באייפון אין API להתקנה — מציגים הנחיה (שיתוף ← הוסף למסך הבית).
(() => {
  const buttons = [...document.querySelectorAll('[data-install]')];
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!buttons.length || standalone) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  const show = (on) => buttons.forEach((b) => { b.hidden = !on; });
  if (isIOS) show(true);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; show(true); });
  window.addEventListener('appinstalled', () => { deferred = null; show(false); toast('נשמר כאפליקציה במסך הבית ✓'); });
  buttons.forEach((b) => b.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') show(false);
    } else if (isIOS) {
      toast('באייפון: הקישו על כפתור השיתוף ⬆️ ואז "הוסף למסך הבית"');
    }
  }));
  function toast(msg) {
    document.querySelector('.bd-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'bd-toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    (document.querySelector('.bd') || document.body).append(t);
    setTimeout(() => t.remove(), 6000);
  }
})();

// שיתוף האתר (מסכי הכניסה): תפריט השיתוף של הטלפון; במחשב — העתקת הקישור, ואם אי אפשר — וואטסאפ
document.querySelectorAll('[data-share]').forEach((btn) => btn.addEventListener('click', async () => {
  const url = location.origin + '/';
  const { shareTitle: title, shareText: text } = btn.dataset;
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); } catch { /* המשתמש ביטל */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    const t = document.createElement('div');
    t.className = 'bd-toast'; t.setAttribute('role', 'status'); t.textContent = 'הקישור לאתר הועתק ✓';
    (document.querySelector('.bd') || document.body).append(t);
    setTimeout(() => t.remove(), 4000);
  } catch {
    window.open(`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`, '_blank', 'noopener');
  }
}));

// דף הבית: חשיפה הדרגתית של אזורים בגלילה
(() => {
  const els = document.querySelectorAll('[data-reveal]');
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach((e, i) => { e.style.transitionDelay = `${(i % 3) * 90}ms`; io.observe(e); });
})();

// ייבוא מאקסל: תיקון שורות בתצוגה המקדימה. הטקסט בתיבה מנורמל (שורה = מקורב, טאב = תא),
// כל שינוי בתא מעדכן את השורה המתאימה בתיבה; "עדכון התצוגה" בודק מחדש בשרת.
(() => {
  const ta = document.querySelector('.bd-import-text');
  if (!ta) return;
  const form = ta.form;
  const dirty = document.querySelector('[data-import-dirty]');
  const setCell = (line, col, value) => {
    const lines = ta.value.split('\n');
    const cells = (lines[line] ?? '').split('\t');
    while (cells.length <= col) cells.push('');
    cells[col] = value.replace(/[\t\r\n]+/g, ' ');
    lines[line] = cells.join('\t');
    ta.value = lines.join('\n');
    if (dirty) dirty.hidden = false;
  };
  form.addEventListener('input', (e) => {
    const el = e.target.closest('[data-line][data-col]');
    if (el) setCell(+el.dataset.line, +el.dataset.col, el.value);
  });
  form.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-row]'), drop = e.target.closest('[data-drop-row]');
    if (!edit && !drop) return;
    const tr = e.target.closest('tr[data-row]');
    const line = +tr.dataset.row;
    const ed = form.querySelector(`[data-edit-for="${line}"]`);
    if (edit) { ed.hidden = !ed.hidden; if (!ed.hidden) ed.querySelector('input')?.focus(); return; }
    // הסרת שורה: מרוקנים את תאיה (השורה נשארת ריקה, כך שמספור השורות האחרות לא זז)
    const lines = ta.value.split('\n');
    lines[line] = '';
    ta.value = lines.join('\n');
    tr.remove(); ed?.remove();
    if (dirty) dirty.hidden = false;
  });
  // "ליצור סיווגים חדשים" — מרענן את התצוגה מיד
  form.querySelectorAll('[data-autosubmit-preview]').forEach((cb) => cb.addEventListener('change', () => {
    const h = document.createElement('input');
    h.type = 'hidden'; h.name = 'action'; h.value = 'preview';
    form.append(h); form.submit();
  }));
})();

// כפתור "העתקת קישור"
document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  const label = btn.querySelector('span');
  const orig = label ? label.textContent : '';
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    if (label) label.textContent = 'הועתק ✓';
  } catch {
    window.prompt('העתיקו את הקישור:', btn.dataset.copy);
  }
  btn.classList.add('is-copied');
  setTimeout(() => { btn.classList.remove('is-copied'); if (label) label.textContent = orig; }, 1800);
}));

// חיפוש מיידי ברשימה: <input data-filter="#list"> מסנן את פריטי הרשימה לפי הטקסט שלהם (גם בלי ניקוד/רווחים כפולים)
document.querySelectorAll('[data-filter]').forEach((input) => {
  const list = document.querySelector(input.dataset.filter);
  const empty = document.querySelector(`[data-filter-empty="${input.dataset.filter}"]`);
  if (!list) return;
  const norm = (t) => t.replace(/[֑-ׇ"'׳״\-\s]+/g, ' ').trim().toLowerCase();
  const items = [...list.children].map((li) => ({ li, text: norm((li.querySelector('.bd-item__main') || li).textContent) }));
  input.addEventListener('input', () => {
    const qv = norm(input.value);
    let shown = 0;
    for (const { li, text } of items) { const on = !qv || text.includes(qv); li.hidden = !on; shown += on; }
    if (empty) empty.hidden = shown > 0;
  });
});

// בחירת טווח בדשבורד: חלון עם לוח שנה (לחיצה ראשונה = התחלה, שנייה = סוף), טווחים מוכנים ושדות תאריך
(() => {
  const dlg = document.getElementById('bd-range');
  const form = dlg?.querySelector('[data-range-form]');
  if (!form) return;
  const cal = form.querySelector('[data-cal]'), sum = form.querySelector('[data-range-sum]');
  const fromI = form.elements.from, toI = form.elements.to;
  const MAX = +form.dataset.max || 366;
  const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = parse(form.dataset.today) || new Date();
  const fmt = (d) => `${d.getDate()}.${d.getMonth() + 1}${d.getFullYear() !== today.getFullYear() ? '.' + d.getFullYear() : ''}`;
  // ימים עבריים לכל חודש מוצג — מהשרת (נשמר במטמון לפי חודש)
  const hebCache = new Map();
  const loadHeb = (y, m) => {
    const k = `${y}-${m + 1}`;
    if (!hebCache.has(k)) hebCache.set(k, fetch(`/api/hebmonth?y=${y}&m=${m + 1}`).then((r) => r.json()).catch(() => null));
    return hebCache.get(k);
  };
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  let a = parse(fromI.value), b = parse(toI.value), shown = new Date((a || today).getFullYear(), (a || today).getMonth(), 1), picking = false;

  const render = () => {
    const y = shown.getFullYear(), m = shown.getMonth();
    const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    let html = `<div class="bd-cal__nav"><button type="button" data-nav="-1" aria-label="החודש הקודם">›</button>
      <div class="bd-cal__month"><b>${MONTHS[m]} ${y}</b><small data-heb-month>&nbsp;</small></div>
      <button type="button" data-nav="1" aria-label="החודש הבא">‹</button></div><div class="bd-cal__grid" role="grid">`;
    html += ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].map((d) => `<span class="bd-cal__dow">${d}</span>`).join('');
    for (let i = 0; i < first.getDay(); i++) html += '<span></span>';
    for (let d = 1; d <= days; d++) {
      const dt = new Date(y, m, d), t = +dt;
      const cls = ['bd-cal__day'];
      if (a && b && t > +a && t < +b) cls.push('is-in');
      if (a && t === +a) cls.push('is-start');
      if (b && t === +b) cls.push('is-end');
      if (t === +today) cls.push('is-today');
      if (dt.getDay() === 6) cls.push('is-shabbat');
      html += `<button type="button" class="${cls.join(' ')}" data-day="${iso(dt)}" aria-pressed="${!!(a && b && t >= +a && t <= +b)}"><span>${d}</span><small></small></button>`;
    }
    cal.innerHTML = html + '</div>';
    loadHeb(y, m).then((h) => {
      if (!h?.days || shown.getFullYear() !== y || shown.getMonth() !== m) return;
      cal.querySelector('[data-heb-month]').textContent = h.month;
      cal.querySelectorAll('[data-day] small').forEach((el, i) => { el.textContent = h.days[i] || ''; });
    });
    const n = a && b ? Math.round((b - a) / 864e5) + 1 : 0;
    sum.textContent = a && b ? `${fmt(a)} – ${fmt(b)} · ${n} ימים` : a ? 'בחרו תאריך סיום' : 'בחרו תאריך התחלה';
    form.querySelector('button:not([type])').disabled = !(a && b);
  };
  const set = (x, y2) => {
    a = x; b = y2;
    if (a && b && b < a) [a, b] = [b, a];
    if (a && b && (b - a) / 864e5 >= MAX) b = add(a, MAX - 1);
    fromI.value = a ? iso(a) : ''; toI.value = b ? iso(b) : '';
    render();
  };
  cal.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { shown = new Date(shown.getFullYear(), shown.getMonth() + +nav.dataset.nav, 1); return render(); }
    const day = e.target.closest('[data-day]');
    if (!day) return;
    const d = parse(day.dataset.day);
    if (!picking || !a || d < a) { picking = true; set(d, null); } else { picking = false; set(a, d); }
  });
  form.querySelector('.bd-range__presets').addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]')?.dataset.preset;
    if (!p) return;
    picking = false;
    if (p === 'next-week') { const s = add(today, 7 - today.getDay()); set(s, add(s, 6)); } else set(today, add(today, +p - 1));
    shown = new Date(a.getFullYear(), a.getMonth(), 1); render();
  });
  [fromI, toI].forEach((el) => el.addEventListener('change', () => {
    picking = false; set(parse(fromI.value), parse(toI.value));
    if (a) { shown = new Date(a.getFullYear(), a.getMonth(), 1); render(); }
  }));
  document.querySelectorAll('[data-range-open]').forEach((el) => el.addEventListener('click', (e) => {
    if (typeof dlg.showModal !== 'function') return; // דפדפן ישן — הקישור מציג 30 יום
    e.preventDefault(); render(); dlg.showModal();
  }));
  dlg.querySelector('[data-range-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
})();
