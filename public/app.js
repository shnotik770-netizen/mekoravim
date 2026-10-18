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
    const my = ++seq; // כל שינוי (גם ריקון שדה) מבטל תשובות קודמות שעוד בדרך
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
  // תיקונים שעוד לא נבדקו — אין לשמור לפני "עדכון תצוגה" (המספר על הכפתור כבר לא נכון)
  const markDirty = () => {
    if (dirty) dirty.hidden = false;
    const save = form.querySelector('button[value=save]');
    if (save && !save.disabled) { save.disabled = true; save.dataset.label = save.textContent; save.textContent = 'עדכנו את התצוגה לפני השמירה'; }
  };
  const setCell = (line, col, value) => {
    const lines = ta.value.split('\n');
    const cells = (lines[line] ?? '').split('\t');
    while (cells.length <= col) cells.push('');
    cells[col] = value.replace(/[\t\r\n]+/g, ' ');
    lines[line] = cells.join('\t');
    ta.value = lines.join('\n');
    markDirty();
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
    markDirty();
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
    btn.classList.add('is-copied');
  } catch {
    window.prompt('העתיקו את הקישור:', btn.dataset.copy);
  }
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
function initRange(dlg) {
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
  // ימים עבריים לכל חודש מוצג — מהשרת (נשמר במטמון)
  const cache = new Map();
  const getJSON = (url) => { if (!cache.has(url)) cache.set(url, fetch(url).then((r) => r.json()).catch(() => null)); return cache.get(url); };
  const MISSED_MAX = 180;
  const isMissed = () => form.dataset.mode === 'missed';
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  let a = parse(fromI.value), b = parse(toI.value), shown = new Date((a || today).getFullYear(), (a || today).getMonth(), 1), picking = false;

  const summary = () => {
    if (!(a && b)) { sum.innerHTML = `<span>${a ? 'בחרו תאריך סיום' : 'בחרו תאריך התחלה'}</span>`; return; }
    const n = Math.round((b - a) / 864e5) + 1, key = iso(a) + iso(b);
    sum.dataset.key = key;
    sum.innerHTML = `<b>&nbsp;</b><span><bdi>${fmt(a)} – ${fmt(b)}</bdi> · ${n} ימים</span>`;
    getJSON(`/api/hebrange?from=${iso(a)}&to=${iso(b)}`).then((h) => { if (h?.label && sum.dataset.key === key) sum.querySelector('b').textContent = h.label; });
  };
  const render = () => {
    const y = shown.getFullYear(), m = shown.getMonth();
    const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    let html = `<div class="bd-cal__nav"><button type="button" data-nav="-1" aria-label="החודש הקודם"${isMissed() && y * 12 + m <= add(today, -MISSED_MAX).getFullYear() * 12 + add(today, -MISSED_MAX).getMonth() ? ' disabled' : ''}>›</button>
      <div class="bd-cal__month"><b>${MONTHS[m]} ${y}</b><small data-heb-month>&nbsp;</small></div>
      <button type="button" data-nav="1" aria-label="החודש הבא"${isMissed() && y === today.getFullYear() && m === today.getMonth() ? ' disabled' : ''}>‹</button></div><div class="bd-cal__grid">`;
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
      const off = isMissed() && (t >= +today || t < +add(today, -MISSED_MAX));
      if (off) cls.push('is-off');
      if (off) { html += `<span class="${cls.join(' ')}" aria-disabled="true"><span>${d}</span><small></small></span>`; continue; }
      html += `<button type="button" class="${cls.join(' ')}" data-day="${iso(dt)}" aria-pressed="${!!(a && b && t >= +a && t <= +b)}"><span>${d}</span><small></small></button>`;
    }
    cal.innerHTML = html + '</div>';
    getJSON(`/api/hebmonth?y=${y}&m=${m + 1}`).then((h) => {
      if (!h?.days || shown.getFullYear() !== y || shown.getMonth() !== m) return;
      cal.querySelector('[data-heb-month]').textContent = h.month;
      cal.querySelectorAll('.bd-cal__day small').forEach((el, i) => { el.textContent = h.days[i] || ''; });
    });
    summary();
    form.querySelector('button:not([type])').disabled = !(a && b);
  };
  const set = (x, y2) => {
    a = x; b = y2;
    if (a && b && b < a) [a, b] = [b, a];
    if (isMissed()) { // אחורה בלבד: עד אתמול, ועד 180 יום
      const yest = add(today, -1), min = add(today, -MISSED_MAX);
      if (a && a > yest) a = yest; if (b && b > yest) b = yest;
      if (a && a < min) a = min; if (b && b < min) b = min;
    }
    if (a && b && (b - a) / 864e5 >= MAX) b = add(a, MAX - 1);
    fromI.value = a ? iso(a) : ''; toI.value = b ? iso(b) : '';
    render();
  };
  cal.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const next = new Date(shown.getFullYear(), shown.getMonth() + +nav.dataset.nav, 1);
      if (isMissed() && (next > today || next < new Date(add(today, -MISSED_MAX).getFullYear(), add(today, -MISSED_MAX).getMonth(), 1))) return;
      shown = next; return render();
    }
    const day = e.target.closest('[data-day]');
    if (!day) return;
    const d = parse(day.dataset.day);
    if (!picking || !a || d < a) { picking = true; set(d, null); } else { picking = false; set(a, d); }
  });
  form.querySelector('.bd-range__presets').addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]')?.dataset.preset;
    if (!p) return;
    picking = false;
    if (p === 'next-week') { const s = add(today, 7 - today.getDay()); set(s, add(s, 6)); }
    else if (form.dataset.mode === 'missed') set(add(today, -+p), add(today, -1)); // אחורה: עד אתמול
    else set(today, add(today, +p - 1));
    shown = new Date(a.getFullYear(), a.getMonth(), 1); render();
  });
  [fromI, toI].forEach((el) => el.addEventListener('change', () => {
    picking = false; set(parse(fromI.value), parse(toI.value));
    if (a) { shown = new Date(a.getFullYear(), a.getMonth(), 1); render(); }
  }));
  dlg.querySelector('[data-range-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const title = dlg.querySelector('.bd-range__title'), submit = form.querySelector('button:not([type])');
  dlg.openRange = (mode = 'range') => {
    const missed = mode === 'missed';
    form.dataset.mode = mode; form.elements.view.value = missed ? 'missed' : 'range';
    title.textContent = missed ? 'ימי הולדת שעברו — בחירת טווח' : 'בחירת טווח תאריכים';
    submit.textContent = missed ? 'הצגת מי שלא בירכו בטווח' : 'הצגת ימי ההולדת בטווח';
    form.querySelectorAll('[data-future]').forEach((el) => { el.hidden = missed; });
    form.querySelectorAll('[data-past]').forEach((el) => { el.hidden = !missed; });
    fromI.max = toI.max = missed ? iso(add(today, -1)) : '';
    fromI.min = toI.min = missed ? iso(add(today, -MISSED_MAX)) : '';
    // מעבר בין מצבים: טווח ברירת מחדל מתאים (שבועיים אחורה / 30 יום קדימה)
    if (missed && !(b && b < today)) set(add(today, -14), add(today, -1));
    if (!missed && form.dataset.was === 'missed') set(today, add(today, 29));
    form.dataset.was = mode;
    picking = false; shown = new Date((a || today).getFullYear(), (a || today).getMonth(), 1);
    render(); dlg.showModal();
  };
  form.dataset.was = form.elements.view.value;
}
initRange(document.getElementById('bd-range'));

// דשבורד: מעבר בין היום / השבוע / החודש / טווח / סיווג בלי טעינת דף — נשארים באותו מקום בדף
(() => {
  if (!document.getElementById('bd-list-title')) return;
  const PARTS = ['.bd-stats', '.bd-chips', 'section[aria-labelledby="bd-list-title"]', '#bd-range', '.bd-missed-btn', '.bd-layout--split > aside', '.bd-takeaway--below'];
  let loadSeq = 0, ctrl = null;
  const load = async (url, push) => {
    const my = ++loadSeq; // רק הבקשה האחרונה קובעת — לחיצות מהירות לא "חוזרות אחורה"
    ctrl?.abort(); ctrl = new AbortController();
    const focusHref = document.activeElement?.getAttribute?.('href');
    const list = document.querySelector(PARTS[2]);
    list?.classList.add('bd-swapping');
    try {
      const r = await fetch(url, { headers: { Accept: 'text/html' }, signal: ctrl.signal });
      if (!r.ok || r.redirected) throw new Error();
      const html = await r.text();
      if (my !== loadSeq) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const sel of PARTS) {
        const cur = document.querySelector(sel), next = doc.querySelector(sel);
        if (cur && next) cur.replaceWith(next);
      }
      initRange(document.getElementById('bd-range'));
      if (push && new URL(url, location.href).href !== location.href) history.pushState({ dash: 1 }, '', url);
      // הפוקוס חוזר לאותו כפתור (או לכותרת הרשימה) — לא "נעלם" לראש הדף
      const target = (focusHref && [...document.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === focusHref)) || document.getElementById('bd-list-title');
      if (target) { if (target.id === 'bd-list-title') target.tabIndex = -1; target.focus({ preventScroll: true }); }
    } catch (e) { if (e.name !== 'AbortError' && my === loadSeq) location.href = url; }
    finally { if (my === loadSeq) document.querySelector(PARTS[2])?.classList.remove('bd-swapping'); }
  };
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const opener = e.target.closest('[data-range-open]');
    const dlg = document.getElementById('bd-range');
    if (opener && dlg?.openRange && typeof dlg.showModal === 'function') { e.preventDefault(); return dlg.openRange(opener.dataset.rangeOpen || 'range'); }
    const a = e.target.closest('.bd-stats a, .bd-chips a, .bd-seg a, .bd-missed-chips a, a.bd-missed-btn, a.bd-alert__more, a.bd-back-normal');
    if (!a || !a.getAttribute('href')?.startsWith('?')) return;
    e.preventDefault();
    load(a.href, true);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-range-form]');
    if (!form) return;
    e.preventDefault();
    form.closest('dialog')?.close();
    load(location.pathname + '?' + new URLSearchParams(new FormData(form)), true);
  });
  window.addEventListener('popstate', () => load(location.href, false));
  window.bdReload = () => load(location.href, false);
})();

// שורה מכווצת של "נוצר קשר": לחיצה (לא על קישור/כפתור) פותחת/סוגרת את הפרטים
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-row-toggle]');
  const row = e.target.closest('.bd-row--done');
  if (!row || (!t && e.target.closest('a, button, form'))) return;
  const open = row.classList.toggle('is-open');
  row.querySelector('[data-row-toggle]')?.setAttribute('aria-expanded', open);
});

// "יצרתי קשר" בדשבורד: נשמר בלי טעינת דף, ונפתח חלון קליל — "נשמר בהצלחה" + איך נוצר הקשר / הערה (רשות).
// לחיצה על וואטסאפ: שאלה — לשלוח ולסמן שנוצר קשר, או רק לשלוח.
(() => {
  const dlg = document.getElementById('bd-qlog');
  if (!dlg || typeof dlg.showModal !== 'function') return;
  const form = dlg.querySelector('[data-qlog-form]'), sub = dlg.querySelector('[data-qlog-sub]');
  let cur = null;
  const post = async (url, data) => {
    // keepalive: הבקשה ממשיכה גם אם הדף עובר לרקע (למשל כשנפתחת אפליקציית וואטסאפ)
    const r = await fetch(url, { method: 'POST', keepalive: true, headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  };
  const logIt = async (f, method) => {
    const btn = f.querySelector('button'); if (btn) btn.disabled = true;
    const data = new FormData(f); if (method) data.set('note', method);
    let r;
    // רק אם השמירה עצמה נכשלה — שליחה רגילה של הטופס (אחרת היה נרשם פעמיים)
    try { r = await post(f.action, data); } catch { f.submit(); return; }
    try {
      cur = { url: `${f.action}/${r.id}/note` };
      form.reset();
      if (method) { const m = form.querySelector(`input[name=method][value="${method}"]`); if (m) m.checked = true; }
      sub.textContent = `נרשם שנוצר קשר עם ${f.dataset.name || ''}${r.demo ? ' (בהדגמה זה לא נשמר באמת)' : ''}`;
      dlg.showModal();
    } catch { window.bdReload ? window.bdReload() : location.reload(); }
  };
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-quicklog]');
    if (!f) return;
    e.preventDefault(); logIt(f);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    if (cur && (fd.get('method') || String(fd.get('note') || '').trim())) { try { await post(cur.url, fd); } catch {} }
    dlg.close();
  });
  dlg.querySelector('[data-qlog-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { cur = null; window.bdReload ? window.bdReload() : location.reload(); });

  // וואטסאפ
  const ask = document.getElementById('bd-waask');
  let waLink = null, waForm = null;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.bd-icon-btn--wa');
    const f = a?.closest('li')?.querySelector('form[data-quicklog]');
    if (!a || !f || !ask) return; // כבר סומן — וואטסאפ רגיל
    e.preventDefault();
    waLink = a.href; waForm = f;
    ask.querySelector('[data-wa-sub]').textContent = `לשלוח ברכה ל${f.dataset.name || ''} ולסמן שנוצר קשר?`;
    ask.showModal();
  });
  ask?.querySelector('[data-wa-mark]').addEventListener('click', () => { window.open(waLink, '_blank', 'noopener'); ask.close(); logIt(waForm, 'וואטסאפ'); });
  ask?.querySelector('[data-wa-only]').addEventListener('click', () => { window.open(waLink, '_blank', 'noopener'); ask.close(); });
  ask?.querySelector('[data-wa-cancel]').addEventListener('click', () => ask.close());
  ask?.addEventListener('click', (e) => { if (e.target === ask) ask.close(); });
})();

// קישור שקופץ לטופס וממקם את הסמן בשדה הראשון (למשל "+ שליח חדש" בדף המנהל)
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-focus]');
  const el = a && document.querySelector(a.dataset.focus);
  if (!el) return;
  e.preventDefault();
  el.closest('section, aside, form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => el.focus({ preventScroll: true }), 350);
});

// כרטיסים מתקפלים — זוכרים מה כווץ (לכל כותרת)
document.querySelectorAll('details[data-fold]').forEach((d) => {
  const key = 'fold:' + location.pathname.split('/')[1] + ':' + (d.id || d.querySelector('summary')?.textContent.trim());
  try { if (localStorage.getItem(key) === '0') d.open = false; } catch {}
  d.addEventListener('toggle', () => { try { d.open ? localStorage.removeItem(key) : localStorage.setItem(key, '0'); } catch {} });
});

// טפסי כניסה — שליחה אחת בלבד (מילוי אוטומטי של קוד מה-SMS + לחיצה שולחים פעמיים, והשנייה נכשלת)
document.querySelectorAll('form[data-once]').forEach((f) => f.addEventListener('submit', (e) => {
  if (f.dataset.sent) { e.preventDefault(); return; }
  f.dataset.sent = '1';
  setTimeout(() => { delete f.dataset.sent; }, 8000);
}));
window.addEventListener('pageshow', () => document.querySelectorAll('form[data-once]').forEach((f) => { delete f.dataset.sent; }));

// בועות יצירת קשר — גלילה להודעה האחרונה
document.querySelectorAll('[data-chat]').forEach((el) => { el.scrollTop = el.scrollHeight; });
