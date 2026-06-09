/*
 * app.js — logic for the final site (index.html).
 *
 * Adds, on top of the preview behaviour:
 *   - To-Do items have a DUE DATE and a 0–3 STAR PRIORITY
 *   - To-Do lists are SORTED: open before done, higher priority first,
 *     then earliest due date, then items with a due date before those without
 *   - A SYNC panel: enter a GitHub token → data is stored in a secret gist
 *     and syncs across devices (auto-creates the gist on first save)
 *
 * DOM contract (see index.html):
 *   section[data-list]                       list = todo|shopping|bucket
 *     form.add > input[type=text]
 *       (todo also: input.due-input[type=date], .star-pick > button[data-star],
 *                   .term-toggle > button[data-term])
 *     [data-count]
 *     ul.list[data-group="now|later|all"]
 *   #syncStatus  #settingsBtn  #settingsPanel
 *   #tokenInput  #saveToken  #signOut  #gistLink  #connState
 *   #clearDone
 */
(function () {
  'use strict';

  var store = new TodoStore({
    backend: 'gist',
    cacheKey: 'todo-data',
    onChange: render,
    onStatus: setStatus
  });

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fmtDue(due) {
    var d = new Date(due + 'T00:00:00');
    if (isNaN(d)) return due;
    var today = new Date(todayStr() + 'T00:00:00');
    var days = Math.round((d - today) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function isOverdue(item) {
    return item.due && !item.done && item.due < todayStr();
  }

  function sortTodos(items) {
    return items.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      var pa = a.priority || 0, pb = b.priority || 0;
      if (pb !== pa) return pb - pa;
      var ad = a.due || '', bd = b.due || '';
      if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return 0;
    });
  }

  // ---------- star widget ----------
  function makeStars(item, onPick) {
    var wrap = el('span', 'stars');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Priority');
    for (var i = 1; i <= 3; i++) {
      (function (n) {
        var b = el('button', 'star' + ((item.priority || 0) >= n ? ' on' : ''));
        b.type = 'button';
        b.innerHTML = '★';
        b.title = 'Priority ' + n;
        b.setAttribute('aria-label', 'Set priority ' + n);
        b.addEventListener('click', function () {
          onPick((item.priority || 0) === n ? n - 1 : n); // click filled top star to clear
        });
        wrap.appendChild(b);
      })(i);
    }
    return wrap;
  }

  // ---------- item rendering ----------
  function commonControls(li, list, item) {
    var cb = el('input', 'check');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.setAttribute('aria-label', item.done ? 'Mark not done' : 'Mark done');
    cb.addEventListener('change', function () { store.toggle(list, item.id); });

    var txt = el('span', 'txt', item.text);
    txt.setAttribute('contenteditable', 'true');
    txt.setAttribute('spellcheck', 'false');
    txt.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); txt.blur(); }
    });
    txt.addEventListener('blur', function () {
      var v = txt.textContent.trim();
      if (v && v !== item.text) store.edit(list, item.id, v);
      else if (!v) store.remove(list, item.id);
    });

    var del = el('button', 'del');
    del.type = 'button';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', function () { store.remove(list, item.id); });

    return { cb: cb, txt: txt, del: del };
  }

  function makeTodoItem(item) {
    var li = el('li', 'item' + (item.done ? ' done' : ''));
    li.dataset.id = item.id;
    var c = commonControls(li, 'todo', item);

    var main = el('span', 'main');
    main.appendChild(c.txt);

    var meta = el('span', 'meta');
    // due badge / picker
    var dueWrap = el('label', 'due' + (isOverdue(item) ? ' overdue' : '') + (item.due ? ' set' : ''));
    dueWrap.title = 'Due date';
    var dueText = el('span', 'due-text', item.due ? fmtDue(item.due) : '＋ due');
    var dueInput = el('input', 'due-edit');
    dueInput.type = 'date';
    dueInput.value = item.due || '';
    dueInput.addEventListener('change', function () { store.setDue('todo', item.id, dueInput.value); });
    dueInput.addEventListener('click', function () {
      if (dueInput.showPicker) { try { dueInput.showPicker(); } catch (e) { /* not allowed */ } }
    });
    dueWrap.appendChild(dueText);
    dueWrap.appendChild(dueInput);
    if (item.due) {
      var clr = el('button', 'due-clear', '×');
      clr.type = 'button';
      clr.title = 'Clear due date';
      clr.addEventListener('click', function (e) { e.preventDefault(); store.setDue('todo', item.id, ''); });
      dueWrap.appendChild(clr);
    }

    meta.appendChild(makeStars(item, function (p) { store.setPriority('todo', item.id, p); }));
    meta.appendChild(dueWrap);

    main.appendChild(meta);

    li.appendChild(c.cb);
    li.appendChild(main);
    li.appendChild(c.del);
    return li;
  }

  function makeSimpleItem(list, item) {
    var li = el('li', 'item' + (item.done ? ' done' : ''));
    li.dataset.id = item.id;
    var c = commonControls(li, list, item);
    li.appendChild(c.cb);
    li.appendChild(c.txt);
    li.appendChild(c.del);
    return li;
  }

  function fillGroup(ul, list, items) {
    ul.innerHTML = '';
    if (!items.length) {
      ul.appendChild(el('li', 'empty', ul.dataset.empty || 'Nothing here yet.'));
      return;
    }
    items.forEach(function (it) {
      ul.appendChild(list === 'todo' ? makeTodoItem(it) : makeSimpleItem(list, it));
    });
  }

  function render() {
    document.querySelectorAll('section[data-list]').forEach(function (section) {
      var list = section.dataset.list;
      var items = store.get(list);
      if (list === 'todo') items = sortTodos(items);

      section.querySelectorAll('ul.list').forEach(function (ul) {
        var group = ul.dataset.group;
        var subset = group === 'all' ? items
          : items.filter(function (it) { return (it.term || 'later') === group; });
        fillGroup(ul, list, subset);
      });

      var countEl = section.querySelector('[data-count]');
      if (countEl) {
        var open = items.filter(function (it) { return !it.done; }).length;
        countEl.textContent = open === 0 ? (items.length ? 'all done' : 'empty') : open + ' open';
      }
    });
  }

  // ---------- add forms ----------
  function wireForms() {
    document.querySelectorAll('section[data-list]').forEach(function (section) {
      var list = section.dataset.list;
      var form = section.querySelector('form.add');
      if (!form) return;
      var input = form.querySelector('input[type=text]');
      var dueInput = form.querySelector('.due-input');
      var starPick = form.querySelector('.star-pick');
      var toggle = form.querySelector('.term-toggle');

      var term = 'now', priority = 0;

      if (toggle) {
        toggle.querySelectorAll('button[data-term]').forEach(function (b) {
          if (b.classList.contains('on')) term = b.dataset.term;
          b.addEventListener('click', function () {
            term = b.dataset.term;
            toggle.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          });
        });
      }

      function paintStars() {
        if (!starPick) return;
        starPick.querySelectorAll('button[data-star]').forEach(function (b) {
          b.classList.toggle('on', parseInt(b.dataset.star, 10) <= priority);
        });
      }
      if (starPick) {
        starPick.querySelectorAll('button[data-star]').forEach(function (b) {
          b.addEventListener('click', function () {
            var n = parseInt(b.dataset.star, 10);
            priority = priority === n ? n - 1 : n;
            paintStars();
          });
        });
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = input.value.trim();
        if (!v) return;
        if (list === 'todo') {
          store.add('todo', v, { term: term, due: dueInput ? dueInput.value : '', priority: priority });
          if (dueInput) dueInput.value = '';
          priority = 0; paintStars();
        } else {
          store.add(list, v);
        }
        input.value = '';
        input.focus();
      });
    });

    var clear = document.getElementById('clearDone');
    if (clear) clear.addEventListener('click', function () {
      TodoStore.LISTS.forEach(function (l) { store.clearDone(l); });
    });
  }

  // ---------- sync panel ----------
  function setStatus(state, message) {
    var pill = document.getElementById('syncStatus');
    if (!pill) return;
    pill.dataset.state = state;
    var label = { idle: 'Synced', syncing: 'Syncing…', error: 'Sync error' }[state] || state;
    if (state === 'idle' && !store.hasToken()) label = 'Local only';
    pill.querySelector('.label').textContent = label;
    pill.title = message || label;
  }

  function refreshConn() {
    var connected = store.hasToken();
    var connState = document.getElementById('connState');
    var signOut = document.getElementById('signOut');
    var gistLink = document.getElementById('gistLink');
    if (connState) connState.textContent = connected ? 'Connected — syncing to a secret gist.' : 'Not connected. Your lists are saved in this browser only.';
    if (signOut) signOut.style.display = connected ? '' : 'none';
    if (gistLink) {
      var url = store.gistUrl();
      if (connected && url) { gistLink.style.display = ''; gistLink.href = url; }
      else gistLink.style.display = 'none';
    }
    setStatus(store.hasToken() ? (store.getGistId() ? 'idle' : 'idle') : 'idle');
  }

  function wirePanel() {
    var btn = document.getElementById('settingsBtn');
    var panel = document.getElementById('settingsPanel');
    var tokenInput = document.getElementById('tokenInput');
    var saveBtn = document.getElementById('saveToken');
    var signOut = document.getElementById('signOut');

    if (btn && panel) {
      btn.addEventListener('click', function () {
        var open = panel.hasAttribute('hidden');
        if (open) { panel.removeAttribute('hidden'); if (tokenInput) tokenInput.focus(); }
        else panel.setAttribute('hidden', '');
      });
    }
    if (tokenInput) tokenInput.value = ''; // never prefill the secret

    if (saveBtn) saveBtn.addEventListener('click', function () {
      var t = tokenInput.value.trim();
      if (!t) return;
      store.setToken(t);
      tokenInput.value = '';
      refreshConn();
      setStatus('syncing', 'Connecting…');
      store.connect().then(function () {
        // push the local cache up so the new gist gets seeded if remote was empty
        store._changed();
        refreshConn();
      }).catch(function (e) { setStatus('error', e.message); });
    });

    if (signOut) signOut.addEventListener('click', function () {
      store.setToken('');
      store.setGistId('');
      refreshConn();
      setStatus('idle');
    });
  }

  // ---------- boot ----------
  store.init();
  wireForms();
  wirePanel();
  refreshConn();
  render();

  // Sweep expired (ticked-off > 1 week) todo/shopping items hourly while open.
  setInterval(function () { store.purgeExpired(); }, 60 * 60 * 1000);
})();
