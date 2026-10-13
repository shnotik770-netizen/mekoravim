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

// טופס יצירת שליח: שדה קוד רק כשנבחר "עם קוד"
const codeField = document.querySelector('.code-field');
if (codeField) {
  const sync = () => { codeField.hidden = document.querySelector('input[name=with_code]:checked').value !== 'yes'; };
  document.querySelectorAll('input[name=with_code]').forEach((r) => r.addEventListener('change', sync));
  sync();
}

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
