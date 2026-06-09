/*
 * app.js — UI for the data-driven to-do site.
 *
 * Renders sections dynamically from the store, with per-section config
 * (due dates, week/someday split, auto-expiry, sort). Item features:
 * priority stars, color marking, multiple links, notes, subtasks, recurring.
 * Plus a section editor, a task detail dialog, gist sync panel, and auto-pull.
 */
(function () {
  'use strict';

  var store = new TodoStore({ backend: 'gist', cacheKey: 'todo-data', onChange: onData, onStatus: setStatus });
  var COLORS = TodoStore.SECTION_COLORS;

  // ---------- tiny helpers ----------
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function byId(id) { return document.getElementById(id); }
  function labelFor(list) { var s = store.getSection(list); return s ? s.name : list; }

  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fmtDue(due) {
    var d = new Date(due + 'T00:00:00'); if (isNaN(d)) return due;
    var diff = Math.round((d - new Date(todayStr() + 'T00:00:00')) / 86400000);
    if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow'; if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function isOverdue(it) { return it.due && !it.done && it.due < todayStr(); }
  function withScheme(url) { url = (url || '').trim(); if (!url) return ''; return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url; }

  function sortItems(section, items) {
    if (section.config.sort !== 'priority') return items;
    return items.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      var pa = a.priority || 0, pb = b.priority || 0; if (pb !== pa) return pb - pa;
      var ad = a.due || '', bd = b.due || '';
      if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
      if (ad && !bd) return -1; if (!ad && bd) return 1; return 0;
    });
  }

  // ---------- stars ----------
  function makeStars(item, onPick) {
    var wrap = el('span', 'stars'); wrap.setAttribute('aria-label', 'Priority');
    for (var i = 1; i <= 3; i++) (function (n) {
      var b = el('button', 'star' + ((item.priority || 0) >= n ? ' on' : '')); b.type = 'button'; b.innerHTML = '★'; b.title = 'Priority ' + n;
      b.addEventListener('click', function (e) { e.stopPropagation(); onPick((item.priority || 0) === n ? n - 1 : n); });
      wrap.appendChild(b);
    })(i);
    return wrap;
  }

  // ---------- item rendering ----------
  function makeItem(section, item) {
    var draggable = section.config.sort === 'manual' && !section.config.term;
    var li = el('li', 'item' + (item.done ? ' done' : '') + (draggable ? ' draggable' : '') + (item.color ? ' colored' : ''));
    li.dataset.id = item.id;
    if (item.color) li.style.setProperty('--item-color', item.color);

    if (draggable) { var grip = el('span', 'grip'); grip.innerHTML = '⠿'; grip.title = 'Drag to reorder'; li.appendChild(grip); }

    var cb = el('input', 'check'); cb.type = 'checkbox'; cb.checked = item.done;
    cb.setAttribute('aria-label', item.done ? 'Mark not done' : 'Mark done');
    cb.addEventListener('change', function () { store.toggle(section.id, item.id); });

    var main = el('span', 'main');
    var txt = el('span', 'txt'); txt.title = 'Click to open details';
    txt.appendChild(document.createTextNode(item.text || ''));

    var links = item.links || [];
    if (links.length === 1) {
      var a = document.createElement('a'); a.className = 'itag'; a.textContent = '🔗'; a.href = withScheme(links[0].url);
      a.target = '_blank'; a.rel = 'noopener'; a.title = links[0].label || links[0].url;
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      txt.appendChild(a);
    } else if (links.length > 1) { var lm = el('span', 'itag', '🔗' + links.length); lm.title = links.length + ' links'; txt.appendChild(lm); }
    if (item.notes) txt.appendChild(tag('📝', 'Has notes'));
    if (item.subtasks && item.subtasks.length) {
      var done = item.subtasks.filter(function (s) { return s.done; }).length;
      txt.appendChild(tag('☑ ' + done + '/' + item.subtasks.length, 'Subtasks'));
    }
    if (item.recur) txt.appendChild(tag('↻', 'Repeats ' + item.recur));
    txt.addEventListener('click', function () { openDetail(section.id, item.id); });
    main.appendChild(txt);

    var meta = el('span', 'meta');
    meta.appendChild(makeStars(item, function (p) { store.setPriority(section.id, item.id, p); }));
    if (section.config.due) meta.appendChild(makeDueBadge(section, item));
    main.appendChild(meta);

    var del = el('button', 'del'); del.type = 'button'; del.innerHTML = '&times;'; del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', function () { store.remove(section.id, item.id); });

    li.appendChild(cb); li.appendChild(main); li.appendChild(del);
    return li;
  }

  function tag(text, title) { var s = el('span', 'itag', text); if (title) s.title = title; return s; }

  function makeDueBadge(section, item) {
    var wrap = el('label', 'due' + (isOverdue(item) ? ' overdue' : '') + (item.due ? ' set' : ''));
    wrap.title = 'Due date';
    wrap.appendChild(el('span', 'due-text', item.due ? fmtDue(item.due) : '＋ due'));
    var input = el('input', 'due-edit'); input.type = 'date'; input.value = item.due || '';
    input.addEventListener('change', function () { store.setDue(section.id, item.id, input.value); });
    input.addEventListener('click', function () { if (input.showPicker) { try { input.showPicker(); } catch (e) {} } });
    wrap.appendChild(input);
    if (item.due) {
      var clr = el('button', 'due-clear', '×'); clr.type = 'button'; clr.title = 'Clear due date';
      clr.addEventListener('click', function (e) { e.preventDefault(); store.setDue(section.id, item.id, ''); });
      wrap.appendChild(clr);
    }
    return wrap;
  }

  // ---------- grid (section shells) ----------
  var grid;

  function buildCard(section) {
    var card = el('section', 'card' + (section.config.term ? ' wide' : '')); card.dataset.list = section.id;
    card.style.setProperty('--c', section.accent);

    var top = el('div', 'card-top');
    top.appendChild(el('span', 'glyph'));
    var h2 = el('h2'); h2.textContent = (section.icon ? section.icon + ' ' : '') + section.name; top.appendChild(h2);
    var count = el('span', 'count'); count.setAttribute('data-count', ''); top.appendChild(count);
    var menu = el('button', 'sec-menu'); menu.type = 'button'; menu.innerHTML = '⋯'; menu.title = 'Section settings';
    menu.addEventListener('click', function () { openSectionEditor(section.id); });
    top.appendChild(menu);
    card.appendChild(top);

    var form = el('form', 'add'); form.autocomplete = 'off';
    var input = el('input'); input.type = 'text'; input.placeholder = section.config.term ? 'Add a task…' : 'Add an item…'; input.setAttribute('aria-label', 'New item');
    form.appendChild(input);
    var dueInput = null;
    if (section.config.due) { dueInput = el('input', 'due-input'); dueInput.type = 'date'; dueInput.setAttribute('aria-label', 'Due date'); form.appendChild(dueInput); }
    var starPick = el('span', 'star-pick'); starPick.setAttribute('role', 'group'); starPick.setAttribute('aria-label', 'Priority');
    for (var s = 1; s <= 3; s++) { var sb = el('button', null, '★'); sb.type = 'button'; sb.dataset.star = s; starPick.appendChild(sb); }
    form.appendChild(starPick);
    var toggle = null;
    if (section.config.term) {
      toggle = el('span', 'term-toggle'); toggle.setAttribute('role', 'group');
      var bn = el('button', 'on', 'This week'); bn.type = 'button'; bn.dataset.term = 'now';
      var bl = el('button', null, 'Someday'); bl.type = 'button'; bl.dataset.term = 'later';
      toggle.appendChild(bn); toggle.appendChild(bl); form.appendChild(toggle);
    }
    var addBtn = el('button', 'add-btn', 'Add'); addBtn.type = 'submit'; form.appendChild(addBtn);
    card.appendChild(form);

    if (section.config.term) {
      var cols = el('div', 'cols');
      cols.appendChild(group('Today & this week', 'now'));
      cols.appendChild(group('To handle / someday', 'later'));
      card.appendChild(cols);
    } else {
      var ul = el('ul', 'list'); ul.dataset.group = 'all'; card.appendChild(ul);
    }

    wireForm(section, form, input, dueInput, starPick, toggle);
    return card;

    function group(title, key) {
      var box = el('div');
      box.appendChild(el('div', 'subhead', title));
      var u = el('ul', 'list'); u.dataset.group = key; box.appendChild(u);
      return box;
    }
  }

  function wireForm(section, form, input, dueInput, starPick, toggle) {
    var term = 'now', priority = 0;
    if (toggle) toggle.querySelectorAll('button[data-term]').forEach(function (b) {
      b.addEventListener('click', function () { term = b.dataset.term; toggle.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); });
    });
    function paint() { starPick.querySelectorAll('button[data-star]').forEach(function (b) { b.classList.toggle('on', parseInt(b.dataset.star, 10) <= priority); }); }
    starPick.querySelectorAll('button[data-star]').forEach(function (b) {
      b.addEventListener('click', function () { var n = parseInt(b.dataset.star, 10); priority = priority === n ? n - 1 : n; paint(); });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim(); if (!v) return;
      var extra = {};
      if (toggle) extra.term = term;
      if (dueInput) extra.due = dueInput.value;
      extra.priority = priority;
      store.add(section.id, v, extra);
      input.value = ''; if (dueInput) dueInput.value = ''; priority = 0; paint(); input.focus();
    });
  }

  var dragInstances = [];
  function buildGrid() {
    grid.innerHTML = '';
    dragInstances.forEach(function (s) { try { s.destroy(); } catch (e) {} }); dragInstances = [];
    store.getSections().forEach(function (section) { grid.appendChild(buildCard(section)); });

    var addCard = el('button', 'add-section'); addCard.type = 'button';
    addCard.innerHTML = '<span>＋</span> Add section';
    addCard.addEventListener('click', function () { var sec = store.addSection('New section'); openSectionEditor(sec.id); });
    grid.appendChild(addCard);

    renderItems();
    initDrag();
  }

  function renderItems() {
    store.getSections().forEach(function (section) {
      var card = grid.querySelector('section[data-list="' + section.id + '"]'); if (!card) return;
      var items = sortItems(section, store.get(section.id));
      card.querySelectorAll('ul.list').forEach(function (ul) {
        var g = ul.dataset.group;
        var subset = g === 'all' ? items : items.filter(function (it) { return (it.term || 'later') === g; });
        ul.innerHTML = '';
        if (!subset.length) { ul.appendChild(el('li', 'empty', 'Nothing here yet.')); return; }
        subset.forEach(function (it) { ul.appendChild(makeItem(section, it)); });
      });
      var c = card.querySelector('[data-count]');
      if (c) { var open = items.filter(function (it) { return !it.done; }).length; c.textContent = open === 0 ? (items.length ? 'all done' : 'empty') : open + ' open'; }
    });
  }

  function initDrag() {
    if (!window.Sortable) return;
    store.getSections().forEach(function (section) {
      if (!(section.config.sort === 'manual' && !section.config.term)) return;
      var ul = grid.querySelector('section[data-list="' + section.id + '"] ul.list[data-group="all"]'); if (!ul) return;
      dragInstances.push(new window.Sortable(ul, {
        handle: '.grip', draggable: 'li.draggable', animation: 150, delayOnTouchOnly: true, delay: 120, ghostClass: 'drag-ghost',
        onEnd: function () { var ids = Array.prototype.map.call(ul.children, function (li) { return li.dataset.id; }).filter(Boolean); store.reorder(section.id, ids); }
      }));
    });
  }

  // Decide whether a data change needs a structural rebuild or just item refresh.
  var lastSig = '';
  function sig() { return store.getSections().map(function (s) { return [s.id, s.name, s.accent, s.icon, s.kind, s.config.term, s.config.due, s.config.sort, s.config.expire].join(':'); }).join('|'); }
  function onData() {
    var s = sig();
    if (s !== lastSig) { lastSig = s; buildGrid(); } else renderItems();
  }

  // ---------- section editor ----------
  var secEdit = null;
  function openSectionEditor(id) {
    var sec = store.getSection(id); if (!sec) return;
    secEdit = id;
    byId('se-name').value = sec.name;
    byId('se-icon').value = sec.icon || '';
    byId('se-due').checked = sec.config.due;
    byId('se-term').checked = sec.config.term;
    byId('se-expire').value = sec.config.expire || 0;
    byId('se-sort').value = sec.config.sort;
    renderSwatches(byId('se-colors'), sec.accent, function pick(c) { store.updateSection(secEdit, { accent: c }); renderSwatches(byId('se-colors'), c, pick); });
    byId('sectionEditor').removeAttribute('hidden');
    byId('se-name').focus();
  }
  function closeSectionEditor() { byId('sectionEditor').setAttribute('hidden', ''); secEdit = null; }

  function renderSwatches(box, selected, onPick) {
    box.innerHTML = '';
    COLORS.forEach(function (c) {
      var b = el('button', 'swatch' + (c === selected ? ' on' : '')); b.type = 'button'; b.style.background = c; b.title = c;
      b.addEventListener('click', function () { onPick(c); });
      box.appendChild(b);
    });
  }

  function wireSectionEditor() {
    if (!byId('sectionEditor')) return;
    byId('se-name').addEventListener('input', function () { if (secEdit) store.updateSection(secEdit, { name: this.value }); });
    byId('se-icon').addEventListener('input', function () { if (secEdit) store.updateSection(secEdit, { icon: this.value.trim().slice(0, 2) }); });
    byId('se-due').addEventListener('change', function () { if (secEdit) store.updateSection(secEdit, { config: { due: this.checked } }); });
    byId('se-term').addEventListener('change', function () { if (secEdit) store.updateSection(secEdit, { kind: this.checked ? 'tasks' : 'simple', config: { term: this.checked } }); });
    byId('se-expire').addEventListener('input', function () { if (secEdit) store.updateSection(secEdit, { config: { expire: Math.max(0, parseInt(this.value, 10) || 0) } }); });
    byId('se-sort').addEventListener('change', function () { if (secEdit) store.updateSection(secEdit, { config: { sort: this.value } }); });
    byId('se-delete').addEventListener('click', function () {
      if (!secEdit) return;
      if (store.getSections().length <= 1) { alert('Keep at least one section.'); return; }
      if (confirm('Delete this section and all its items?')) { store.removeSection(secEdit); closeSectionEditor(); }
    });
    byId('se-close').addEventListener('click', closeSectionEditor);
    byId('sectionEditor').addEventListener('click', function (e) { if (e.target === this) closeSectionEditor(); });
  }

  // ---------- task detail ----------
  var detail = { list: null, id: null };
  function openDetail(list, id) {
    var it = store.findItem(list, id); if (!it) return;
    var section = store.getSection(list);
    detail.list = list; detail.id = id;
    byId('d-title').value = it.text || '';
    byId('d-notes').value = it.notes || '';
    byId('d-list').textContent = section ? section.name : list;
    renderSwatches2(byId('d-colors'), it.color || '', function pick(c) { var nc = (c === it.color ? '' : c); store.setColor(list, id, nc); it.color = nc; renderSwatches2(byId('d-colors'), it.color || '', pick); });
    var dueRow = byId('d-due-row');
    if (section && section.config.due) {
      dueRow.style.display = ''; byId('d-due').value = it.due || ''; byId('d-recur').value = it.recur || 'none';
    } else dueRow.style.display = 'none';
    renderDetailLinks((it.links || []).slice());
    renderSubtasks(it.subtasks || []);
    byId('detail').removeAttribute('hidden');
    byId('d-title').focus();
  }
  function closeDetail() { byId('detail').setAttribute('hidden', ''); detail.list = null; detail.id = null; }

  function renderSwatches2(box, selected, onPick) {
    box.innerHTML = '';
    var none = el('button', 'swatch none' + (!selected ? ' on' : '')); none.type = 'button'; none.title = 'No colour'; none.innerHTML = '∅';
    none.addEventListener('click', function () { onPick(''); }); box.appendChild(none);
    COLORS.forEach(function (c) {
      var b = el('button', 'swatch' + (c === selected ? ' on' : '')); b.type = 'button'; b.style.background = c; b.title = c;
      b.addEventListener('click', function () { onPick(c); }); box.appendChild(b);
    });
  }

  function renderDetailLinks(links) {
    var box = byId('d-links'); box.innerHTML = '';
    if (!links.length) links = [{ url: '', label: '' }];
    links.forEach(function (lk) { box.appendChild(makeLinkRow(lk.url || '', lk.label || '')); });
  }
  function makeLinkRow(url, label) {
    var row = el('div', 'd-link-row');
    var urlIn = el('input', 'd-link-url'); urlIn.type = 'url'; urlIn.placeholder = 'example.com'; urlIn.value = url;
    var labelIn = el('input', 'd-link-label'); labelIn.type = 'text'; labelIn.placeholder = 'Label (optional)'; labelIn.value = label;
    var open = document.createElement('a'); open.className = 'd-link-open'; open.target = '_blank'; open.rel = 'noopener'; open.textContent = '↗';
    function refresh() { var v = urlIn.value.trim(); if (v) { open.href = withScheme(v); open.style.visibility = 'visible'; } else open.style.visibility = 'hidden'; }
    refresh();
    var del = el('button', 'd-link-del'); del.type = 'button'; del.innerHTML = '&times;'; del.title = 'Remove link';
    urlIn.addEventListener('input', function () { refresh(); persistLinks(); });
    labelIn.addEventListener('input', persistLinks);
    del.addEventListener('click', function () { row.remove(); persistLinks(); });
    row.appendChild(urlIn); row.appendChild(labelIn); row.appendChild(open); row.appendChild(del);
    return row;
  }
  function persistLinks() {
    if (!detail.id) return; var links = [];
    byId('d-links').querySelectorAll('.d-link-row').forEach(function (row) {
      var url = row.querySelector('.d-link-url').value.trim(), label = row.querySelector('.d-link-label').value.trim();
      if (url) links.push(label ? { url: url, label: label } : { url: url });
    });
    store.update(detail.list, detail.id, { links: links });
  }

  function renderSubtasks(subs) {
    var box = byId('d-subs'); box.innerHTML = '';
    subs.forEach(function (s) {
      var row = el('div', 'd-sub-row' + (s.done ? ' done' : ''));
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = s.done; cb.className = 'd-sub-check';
      cb.addEventListener('change', function () { store.toggleSubtask(detail.list, detail.id, s.id); refreshSubs(); });
      var tx = el('input', 'd-sub-text'); tx.type = 'text'; tx.value = s.text;
      tx.addEventListener('input', function () { store.editSubtask(detail.list, detail.id, s.id, tx.value); });
      var del = el('button', 'd-sub-del'); del.type = 'button'; del.innerHTML = '&times;';
      del.addEventListener('click', function () { store.removeSubtask(detail.list, detail.id, s.id); refreshSubs(); });
      row.appendChild(cb); row.appendChild(tx); row.appendChild(del); box.appendChild(row);
    });
  }
  function refreshSubs() { var it = store.findItem(detail.list, detail.id); renderSubtasks(it && it.subtasks ? it.subtasks : []); }

  function wireDetail() {
    var modal = byId('detail'); if (!modal) return;
    byId('d-title').addEventListener('input', function () { if (detail.id) store.update(detail.list, detail.id, { text: this.value }); });
    byId('d-notes').addEventListener('input', function () { if (detail.id) store.update(detail.list, detail.id, { notes: this.value }); });
    byId('d-due').addEventListener('change', function () { if (detail.id) store.setDue(detail.list, detail.id, this.value); });
    byId('d-recur').addEventListener('change', function () { if (detail.id) store.update(detail.list, detail.id, { recur: this.value === 'none' ? undefined : this.value }); });
    byId('d-addlink').addEventListener('click', function () { var r = makeLinkRow('', ''); byId('d-links').appendChild(r); r.querySelector('.d-link-url').focus(); });
    byId('d-addsub').addEventListener('click', function () {
      var t = byId('d-subnew').value.trim(); if (!t || !detail.id) return;
      store.addSubtask(detail.list, detail.id, t); byId('d-subnew').value = ''; refreshSubs(); byId('d-subnew').focus();
    });
    byId('d-subnew').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); byId('d-addsub').click(); } });
    byId('d-close').addEventListener('click', closeDetail);
    byId('d-delete').addEventListener('click', function () { if (detail.id) store.remove(detail.list, detail.id); closeDetail(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeDetail(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!byId('detail').hasAttribute('hidden')) closeDetail();
      else if (!byId('sectionEditor').hasAttribute('hidden')) closeSectionEditor();
    });
  }

  // ---------- sync panel ----------
  function setStatus(state, message) {
    var pill = byId('syncStatus'); if (!pill) return;
    pill.dataset.state = state;
    var label = { idle: 'Synced', syncing: 'Syncing…', error: 'Sync error' }[state] || state;
    if (state === 'idle' && !store.hasToken()) label = 'Local only';
    pill.querySelector('.label').textContent = label; pill.title = message || label;
  }
  function refreshConn() {
    var connected = store.hasToken();
    byId('connState').textContent = connected ? 'Connected — syncing to a secret gist.' : 'Not connected. Your lists are saved in this browser only.';
    byId('signOut').style.display = connected ? '' : 'none';
    byId('syncNow').style.display = connected ? '' : 'none';
    var url = store.gistUrl(); var gl = byId('gistLink');
    if (connected && url) { gl.style.display = ''; gl.href = url; } else gl.style.display = 'none';
    setStatus('idle');
  }
  function wirePanel() {
    var panel = byId('settingsPanel');
    byId('settingsBtn').addEventListener('click', function () { if (panel.hasAttribute('hidden')) { panel.removeAttribute('hidden'); byId('tokenInput').focus(); } else panel.setAttribute('hidden', ''); });
    byId('tokenInput').value = '';
    byId('saveToken').addEventListener('click', function () {
      var t = byId('tokenInput').value.trim(); if (!t) return;
      store.setToken(t); byId('tokenInput').value = ''; refreshConn(); setStatus('syncing', 'Connecting…');
      store.connect().then(function () { store._changed(); refreshConn(); }).catch(function (e) { setStatus('error', e.message); });
    });
    byId('syncNow').addEventListener('click', function () {
      if (!store.hasToken()) return; var btn = this; btn.classList.add('spin'); setStatus('syncing', 'Pulling latest…');
      store.connect().then(refreshConn).catch(function (e) { setStatus('error', e.message); }).then(function () { btn.classList.remove('spin'); });
    });
    byId('signOut').addEventListener('click', function () { store.setToken(''); store.setGistId(''); refreshConn(); setStatus('idle'); });
  }

  // ---------- auto-pull when the tab regains focus ----------
  var lastPull = 0;
  function maybeAutoPull() {
    if (document.hidden || !store.hasToken()) return;
    var now = Date.now(); if (now - lastPull < 4000) return; // avoid rapid repeats
    lastPull = now;
    store.connect().then(refreshConn).catch(function () {});
  }

  // ---------- boot ----------
  grid = byId('grid');
  store.init();
  lastSig = sig();
  buildGrid();
  wireSectionEditor();
  wireDetail();
  wirePanel();
  refreshConn();

  byId('clearDone').addEventListener('click', function () { store.getSections().forEach(function (s) { store.clearDone(s.id); }); });

  window.addEventListener('focus', maybeAutoPull);
  document.addEventListener('visibilitychange', maybeAutoPull);
  setInterval(function () { store.purgeExpired(); }, 60 * 60 * 1000);
})();
