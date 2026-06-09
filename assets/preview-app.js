/*
 * preview-app.js — shared interaction logic for the three design previews.
 *
 * Each preview supplies its own markup + CSS but follows this DOM contract:
 *   section[data-list="todo|shopping|bucket"]
 *     form.add  > input[type=text]  (+ optional .term-toggle > button[data-term])
 *     [data-count]                  (optional: shows "N open")
 *     ul.list[data-group="now|later|all"]
 *   #clearDone                      (optional: clears completed in every list)
 *
 * Items are rendered as: li.item(.done) > input.check + .txt + button.del
 * All three previews use the localStorage backend with a shared cache key,
 * so the same demo content shows across styles for easy comparison.
 */
window.PreviewApp = (function () {
  'use strict';

  var store;

  var SEED = {
    todo: [
      { text: 'Reply to the landlord about the lease', term: 'now' },
      { text: 'Buy a birthday card for Mum', term: 'now' },
      { text: 'Do my taxes', term: 'later' },
      { text: 'Send in the insurance letter', term: 'later' }
    ],
    shopping: ['Oat milk', 'Coffee beans', 'Dish soap', 'Pasta'],
    bucket: ['See the northern lights', 'Learn to surf', 'Visit Japan in spring']
  };

  function seedIfEmpty() {
    var empty = TodoStore.LISTS.every(function (l) { return store.get(l).length === 0; });
    if (!empty) return;
    SEED.todo.forEach(function (t) { store.add('todo', t.text, { term: t.term }); });
    SEED.shopping.forEach(function (t) { store.add('shopping', t); });
    SEED.bucket.forEach(function (t) { store.add('bucket', t); });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeItem(list, item) {
    var li = el('li', 'item' + (item.done ? ' done' : ''));
    li.dataset.id = item.id;

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

    li.appendChild(cb);
    li.appendChild(txt);
    li.appendChild(del);
    return li;
  }

  function fillGroup(ul, list, items) {
    ul.innerHTML = '';
    if (!items.length) {
      var empty = ul.dataset.empty;
      if (empty !== 'skip') ul.appendChild(el('li', 'empty', empty || 'Nothing here yet.'));
      return;
    }
    items.forEach(function (it) { ul.appendChild(makeItem(list, it)); });
  }

  function render() {
    document.querySelectorAll('section[data-list]').forEach(function (section) {
      var list = section.dataset.list;
      var items = store.get(list);

      section.querySelectorAll('ul.list').forEach(function (ul) {
        var group = ul.dataset.group;
        var subset = group === 'all' ? items
          : items.filter(function (it) { return (it.term || 'later') === group; });
        fillGroup(ul, list, subset);
      });

      var countEl = section.querySelector('[data-count]');
      if (countEl) {
        var open = items.filter(function (it) { return !it.done; }).length;
        countEl.textContent = open === 0
          ? (items.length ? 'all done' : 'empty')
          : open + ' open';
      }
    });
  }

  function wireForms() {
    document.querySelectorAll('section[data-list]').forEach(function (section) {
      var list = section.dataset.list;
      var form = section.querySelector('form.add');
      if (!form) return;
      var input = form.querySelector('input[type=text]');

      var toggle = form.querySelector('.term-toggle');
      var term = 'now';
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

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = input.value.trim();
        if (!v) return;
        store.add(list, v, list === 'todo' ? { term: term } : null);
        input.value = '';
        input.focus();
      });
    });

    var clear = document.getElementById('clearDone');
    if (clear) clear.addEventListener('click', function () {
      TodoStore.LISTS.forEach(function (l) { store.clearDone(l); });
    });
  }

  function start() {
    store = new TodoStore({ backend: 'local', cacheKey: 'todo-data-preview', onChange: render });
    store.init();
    seedIfEmpty();
    wireForms();
    render();
  }

  return { start: start };
})();
