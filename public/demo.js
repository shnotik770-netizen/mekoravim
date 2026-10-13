// חשבון הדגמה בדף הבית — הכול בזיכרון הדפדפן בלבד. השרת (/demo/calc) רק מחשב תאריכים ולא שומר דבר.
// סגירה / רענון = התחלה מחדש.
(() => {
  const dlg = document.getElementById('demo');
  if (!dlg) return;
  const body = dlg.querySelector('[data-demo-body]');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VIEWS = [['today', 'היום'], ['week', 'השבוע'], ['month', 'החודש'], ['next30', '30 יום'], ['all', 'כולם']];
  const state = { people: [], options: null, calc: null, view: 'week', marks: {}, adding: false, dateType: 'h', error: '', seq: 0, busy: false };

  async function api(url, payload) {
    const res = await fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {});
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'שגיאה בחישוב');
    return res.json();
  }

  async function seed() {
    const d = await api('/demo/seed');
    state.people = d.people; state.options = d.options; state.marks = {}; state.view = 'week'; state.error = ''; state.adding = false;
    await calc();
  }
  async function calc() {
    state.busy = true;
    try { state.calc = await api('/demo/calc', { people: state.people }); } finally { state.busy = false; }
  }

  function toast(msg) {
    dlg.querySelector('.hm-demo__toast')?.remove();
    const t = document.createElement('div');
    t.className = 'hm-demo__toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    dlg.querySelector('.hm-demo__sheet').append(t);
    setTimeout(() => t.remove(), 3200);
  }

  const whenText = (n) => (n.days === 0 ? 'היום! 🎉' : n.days === 1 ? 'מחר' : n.days < 14 ? `בעוד ${n.days} ימים` : `${n.day} ${n.greg}`);
  const initials = (name) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('');

  function render() {
    const c = state.calc;
    if (!c) { body.innerHTML = '<p class="hm-demo__empty">טוען…</p>'; return; }
    const ok = c.people.filter((p) => !p.error);
    const count = (v) => (v === 'all' ? ok.length : ok.filter((p) => p[v]).length);
    const list = state.view === 'all' ? ok : ok.filter((p) => p[state.view]);
    const o = state.options;
    body.innerHTML = `
      <div class="hm-demo__hello"><b>שלום, בית חב״ד לדוגמה</b><span>היום יום ${esc(c.header.today)}</span></div>
      <div class="hm-demo__tabs" role="tablist">
        ${VIEWS.map(([v, l]) => `<button type="button" role="tab" aria-selected="${state.view === v}" data-view="${v}"><span>${l}</span><b>${count(v)}</b></button>`).join('')}
      </div>
      <ul class="hm-demo__list">
        ${list.length ? list.map((p) => {
          const m = state.marks[p.id] || {};
          return `<li class="${p.today ? 'is-today' : ''} ${m.done ? 'is-done' : ''}">
            <span class="hm-demo__av">${esc(initials(p.name))}</span>
            <div class="hm-demo__main">
              <b>${esc(p.name)}${m.remind ? ' <span title="תזכורת SMS">🔔</span>' : ''}</b>
              <span>${esc(p.next.label)}${p.next.age ? ` · גיל ${p.next.age}` : ''} · <em>${esc(whenText(p.next))}</em></span>
              ${p.next.note ? `<small>ⓘ ${esc(p.next.note)}</small>` : ''}
              <small class="hm-demo__birth">${esc(p.birth)}</small>
            </div>
            <div class="hm-demo__acts">
              <button type="button" data-act="wa" data-id="${esc(p.id)}" aria-label="ברכה בוואטסאפ" title="ברכה בוואטסאפ">💬</button>
              <button type="button" data-act="done" data-id="${esc(p.id)}" aria-pressed="${!!m.done}" aria-label="יצרתי קשר" title="יצרתי קשר">✓</button>
              <button type="button" data-act="remind" data-id="${esc(p.id)}" aria-pressed="${!!m.remind}" aria-label="תזכורת SMS" title="תזכורת SMS">🔔</button>
              <button type="button" data-act="del" data-id="${esc(p.id)}" aria-label="מחיקה" title="מחיקה">✕</button>
            </div>
          </li>`;
        }).join('') : `<li class="hm-demo__none">אין ימי הולדת ${state.view === 'today' ? 'היום' : 'בטווח הזה'} — נסו טווח אחר או הוסיפו מקורב 👇</li>`}
      </ul>
      ${state.adding ? `
      <form class="hm-demo__add" data-add>
        ${state.error ? `<p class="hm-demo__err" role="alert">${esc(state.error)}</p>` : ''}
        <div class="hm-demo__row2">
          <label>שם פרטי<input name="first_name" required maxlength="40" autocomplete="off"></label>
          <label>שם משפחה<input name="last_name" maxlength="40" autocomplete="off"></label>
        </div>
        <div class="hm-demo__seg" role="radiogroup" aria-label="סוג תאריך">
          <button type="button" data-dt="h" aria-pressed="${state.dateType === 'h'}">תאריך עברי</button>
          <button type="button" data-dt="g" aria-pressed="${state.dateType === 'g'}">תאריך לועזי</button>
        </div>
        ${state.dateType === 'h' ? `
        <div class="hm-demo__row3">
          <label>יום<select name="h_day">${o.days.map((d) => `<option value="${d.v}">${esc(d.n)}</option>`).join('')}</select></label>
          <label>חודש<select name="h_month">${o.months.map((m) => `<option value="${m.v}">${esc(m.n)}</option>`).join('')}</select></label>
          <label>שנה <small>(לא חובה)</small><input name="h_year" placeholder='תש"נ' maxlength="8"></label>
        </div>` : `
        <div class="hm-demo__row2">
          <label>תאריך לידה<input type="date" name="g_date" required></label>
          <label class="hm-demo__check"><input type="checkbox" name="after_sunset"> נולד אחרי השקיעה</label>
        </div>`}
        <div class="hm-demo__btns"><button class="hm-btn hm-btn--gold hm-btn--sm" type="submit">הוספה</button><button class="hm-link" type="button" data-act="cancel">ביטול</button></div>
      </form>` : `<button type="button" class="hm-demo__plus" data-act="add">+ הוספת מקורב</button>`}
    `;
  }

  async function act(e) {
    const t = e.target.closest('[data-view],[data-act],[data-dt]');
    if (!t) return;
    if (t.dataset.view) { state.view = t.dataset.view; return render(); }
    if (t.dataset.dt) { state.dateType = t.dataset.dt; return render(); }
    const id = t.dataset.id, m = (state.marks[id] ||= {});
    switch (t.dataset.act) {
      case 'wa': return toast('בחשבון אמיתי — נפתח וואטסאפ עם ברכת מזל טוב מוכנה למקורב');
      case 'done': m.done = !m.done; render(); return m.done && toast('סומן "יצרתי קשר" ✓');
      case 'remind': m.remind = !m.remind; render(); return m.remind && toast('🔔 בחשבון אמיתי — תקבלו SMS לפני יום ההולדת');
      case 'del': state.people = state.people.filter((p) => p.id !== id); await calc(); return render();
      case 'add': state.adding = true; state.error = ''; render(); return dlg.querySelector('[name=first_name]')?.focus();
      case 'cancel': state.adding = false; state.error = ''; return render();
      case 'reset': await seed(); render(); return toast('ההדגמה אופסה');
    }
  }

  async function add(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const p = { id: `u${++state.seq}`, first_name: f.get('first_name'), last_name: f.get('last_name'), date_type: state.dateType };
    if (state.dateType === 'h') Object.assign(p, { h_day: f.get('h_day'), h_month: f.get('h_month'), h_year: f.get('h_year') });
    else Object.assign(p, { g_date: f.get('g_date'), after_sunset: f.get('after_sunset') === 'on' });
    state.people.push(p);
    try { await calc(); } catch (err) { state.people.pop(); state.error = err.message; return render(); }
    const res = state.calc.people.find((x) => x.id === p.id);
    if (res?.error) { state.people.pop(); state.error = res.error; await calc(); return render(); }
    state.adding = false; state.error = '';
    state.view = res.today ? 'today' : res.week ? 'week' : res.month ? 'month' : res.next30 ? 'next30' : 'all';
    render();
    toast(`${res.name} נוסף/ה — ${res.next.label}${res.next.days === 0 ? ', היום!' : ''}`);
  }

  async function open() {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    document.documentElement.classList.add('hm-lock');
    if (!state.calc) {
      render();
      try { await seed(); } catch { body.innerHTML = '<p class="hm-demo__empty">לא ניתן לטעון את ההדגמה כרגע. נסו שוב.</p>'; return; }
    }
    render();
  }
  function close() { dlg.close?.(); dlg.removeAttribute('open'); document.documentElement.classList.remove('hm-lock'); }

  document.querySelectorAll('[data-demo-open]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  dlg.querySelectorAll('[data-demo-close]').forEach((b) => b.addEventListener('click', close));
  dlg.addEventListener('close', () => document.documentElement.classList.remove('hm-lock'));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('click', act);
  dlg.addEventListener('submit', (e) => { if (e.target.matches('[data-add]')) add(e); });
  if (location.hash === '#demo') open();
})();
