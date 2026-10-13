// החלפת תאריך עברי/לועזי (רכיב bd-toggle)
function bindDatebox(box) {
  const sync = () => {
    const h = box.querySelector('input[type=radio][value=h]').checked;
    box.querySelector('.g-fields').hidden = h;
    box.querySelector('.h-fields').hidden = !h;
  };
  box.querySelectorAll('input[type=radio]').forEach((r) => r.addEventListener('change', sync));
  sync();
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
