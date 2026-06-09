/*
 * storage.js — data model + persistence (v2, data-driven sections).
 *
 * Global `TodoStore` (plain script, no modules).
 *
 * Data shape:
 *   {
 *     version: 2,
 *     sections: [ { id, name, accent, icon, kind:'tasks'|'simple',
 *                   config:{ term, due, expire(days), sort:'priority'|'manual' } } ],
 *     items:    { [sectionId]: [ item, ... ] }
 *   }
 *   item: { id, text, done, doneAt?, priority(0-3), color?, links?[{url,label?}],
 *           notes?, subtasks?[{id,text,done}], recur?('daily'|'weekly'|'monthly'),
 *           term?('now'|'later'), due?('YYYY-MM-DD') }
 *
 * Backends: 'local' (browser) and 'gist' (secret gist via the GitHub API → cross-device sync).
 * v1 data ({todo:[],shopping:[],bucket:[]}) is migrated automatically.
 */
(function (global) {
  'use strict';

  var SECTION_COLORS = ['#5df2c9', '#ffc24b', '#b07bff', '#6ea8ff', '#ff7a9c', '#7be081', '#ff9d5c', '#5cd0ff'];

  function defaultSections() {
    return [
      { id: 'todo', name: 'To-Do', accent: '#5df2c9', icon: '', kind: 'tasks', config: { term: true, due: true, expire: 7, sort: 'priority' } },
      { id: 'shopping', name: 'Shopping', accent: '#ffc24b', icon: '', kind: 'simple', config: { term: false, due: false, expire: 7, sort: 'manual' } },
      { id: 'bucket', name: 'Bucket list', accent: '#b07bff', icon: '', kind: 'simple', config: { term: false, due: false, expire: 0, sort: 'manual' } }
    ];
  }

  function emptyData() {
    var sections = defaultSections();
    var items = {};
    sections.forEach(function (s) { items[s.id] = []; });
    return { version: 2, sections: sections, items: items };
  }

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function slug(name) {
    var s = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'section';
  }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function advanceDue(due, recur) {
    var d = new Date(due + 'T00:00:00');
    if (isNaN(d)) return due;
    if (recur === 'daily') d.setDate(d.getDate() + 1);
    else if (recur === 'weekly') d.setDate(d.getDate() + 7);
    else if (recur === 'monthly') d.setMonth(d.getMonth() + 1);
    return ymd(d);
  }

  function b64encode(str) { return global.btoa(unescape(encodeURIComponent(str))); }

  function TodoStore(options) {
    options = options || {};
    this.backend = options.backend || 'local';
    this.cacheKey = options.cacheKey || 'todo-data';
    this.onChange = options.onChange || function () {};
    this.onStatus = options.onStatus || function () {};

    this.tokenKey = options.tokenKey || 'todo-gh-token';
    this.gist = {
      filename: (options.gist && options.gist.filename) || 'todo-data.json',
      description: (options.gist && options.gist.description) || 'Personal to-do site data',
      idKey: (options.gist && options.gist.idKey) || 'todo-gist-id'
    };

    this.data = emptyData();
    this._saveTimer = null;
    this._saving = false;
    this._dirty = false;
  }

  TodoStore.SECTION_COLORS = SECTION_COLORS;

  TodoStore.prototype._notify = function () { try { this.onChange(this.data); } catch (e) {} };
  TodoStore.prototype._status = function (s, m) { try { this.onStatus(s, m); } catch (e) {} };

  // ---- token / gist id ----
  TodoStore.prototype.getToken = function () { return global.localStorage.getItem(this.tokenKey) || ''; };
  TodoStore.prototype.setToken = function (t) { if (t) global.localStorage.setItem(this.tokenKey, t); else global.localStorage.removeItem(this.tokenKey); };
  TodoStore.prototype.hasToken = function () { return !!this.getToken(); };
  TodoStore.prototype.getGistId = function () { return global.localStorage.getItem(this.gist.idKey) || ''; };
  TodoStore.prototype.setGistId = function (id) { if (id) global.localStorage.setItem(this.gist.idKey, id); else global.localStorage.removeItem(this.gist.idKey); };
  TodoStore.prototype.gistUrl = function () { var id = this.getGistId(); return id ? 'https://gist.github.com/' + id : ''; };

  // ---- load ----
  TodoStore.prototype.init = function () {
    var self = this;
    this._loadCache();
    this.purgeExpired();
    this._notify();
    if (this._syncEnabled()) {
      return this._gistLoad().then(function () { self.purgeExpired(); self._notify(); })
        .catch(function (err) { self._status('error', (err && err.message) || 'Sync load failed'); });
    }
    return Promise.resolve();
  };

  TodoStore.prototype._loadCache = function () {
    try {
      var raw = global.localStorage.getItem(this.cacheKey);
      if (raw) this.data = normalize(JSON.parse(raw));
    } catch (e) { this.data = emptyData(); }
  };
  TodoStore.prototype._writeCache = function () {
    try { global.localStorage.setItem(this.cacheKey, JSON.stringify(this.data)); } catch (e) {}
  };

  // ---- sections ----
  TodoStore.prototype.getSections = function () { return this.data.sections.slice(); };
  TodoStore.prototype.getSection = function (id) {
    for (var i = 0; i < this.data.sections.length; i++) if (this.data.sections[i].id === id) return this.data.sections[i];
    return null;
  };
  TodoStore.prototype.addSection = function (name) {
    var id = slug(name) + '-' + Math.random().toString(36).slice(2, 6);
    var accent = SECTION_COLORS[this.data.sections.length % SECTION_COLORS.length];
    var sec = { id: id, name: (name || 'New section').trim() || 'New section', accent: accent, icon: '',
      kind: 'simple', config: { term: false, due: false, expire: 0, sort: 'manual' } };
    this.data.sections.push(sec);
    this.data.items[id] = [];
    this._changed();
    return sec;
  };
  TodoStore.prototype.updateSection = function (id, patch) {
    var sec = this.getSection(id);
    if (!sec) return;
    for (var k in patch) {
      if (k === 'config') { for (var c in patch.config) sec.config[c] = patch.config[c]; }
      else sec[k] = patch[k];
    }
    this._changed();
  };
  TodoStore.prototype.removeSection = function (id) {
    this.data.sections = this.data.sections.filter(function (s) { return s.id !== id; });
    delete this.data.items[id];
    this._changed();
  };
  TodoStore.prototype.reorderSections = function (ids) {
    var byId = {}; this.data.sections.forEach(function (s) { byId[s.id] = s; });
    var next = [];
    ids.forEach(function (id) { if (byId[id]) { next.push(byId[id]); delete byId[id]; } });
    this.data.sections.forEach(function (s) { if (byId[s.id]) next.push(s); });
    this.data.sections = next;
    this._changed();
  };

  // ---- items ----
  TodoStore.prototype.get = function (sid) { return this.data.items[sid] ? this.data.items[sid].slice() : []; };
  TodoStore.prototype._find = function (sid, id) {
    var arr = this.data.items[sid] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  };
  TodoStore.prototype.findItem = function (sid, id) { return this._find(sid, id); };

  TodoStore.prototype.add = function (sid, text, extra) {
    text = (text || '').trim();
    if (!text || !this.data.items[sid]) return null;
    var item = { id: uid(), text: text, done: false };
    if (extra) for (var k in extra) item[k] = extra[k];
    this.data.items[sid].push(item);
    this._changed();
    return item;
  };

  TodoStore.prototype.toggle = function (sid, id) {
    var it = this._find(sid, id);
    if (!it) return;
    it.done = !it.done;
    if (it.done) {
      it.doneAt = Date.now();
      // recurring: spawn the next occurrence when completed
      if (it.recur && it.due) {
        var next = JSON.parse(JSON.stringify(it));
        next.id = uid(); next.done = false; delete next.doneAt;
        next.due = advanceDue(it.due, it.recur);
        if (Array.isArray(next.subtasks)) next.subtasks.forEach(function (s) { s.done = false; });
        this.data.items[sid].push(next);
      }
    } else {
      delete it.doneAt;
    }
    this._changed();
  };

  TodoStore.prototype.edit = function (sid, id, text) { var it = this._find(sid, id); if (it) { it.text = (text || '').trim() || it.text; this._changed(); } };
  TodoStore.prototype.update = function (sid, id, patch) { var it = this._find(sid, id); if (it) { for (var k in patch) it[k] = patch[k]; this._changed(); } };
  TodoStore.prototype.setTerm = function (sid, id, term) { var it = this._find(sid, id); if (it) { it.term = term; this._changed(); } };
  TodoStore.prototype.setDue = function (sid, id, due) { var it = this._find(sid, id); if (it) { it.due = due || ''; this._changed(); } };
  TodoStore.prototype.setPriority = function (sid, id, p) { var it = this._find(sid, id); if (it) { it.priority = Math.max(0, Math.min(3, p | 0)); this._changed(); } };
  TodoStore.prototype.setColor = function (sid, id, color) { var it = this._find(sid, id); if (it) { if (color) it.color = color; else delete it.color; this._changed(); } };
  TodoStore.prototype.remove = function (sid, id) { if (this.data.items[sid]) { this.data.items[sid] = this.data.items[sid].filter(function (it) { return it.id !== id; }); this._changed(); } };
  TodoStore.prototype.clearDone = function (sid) { if (this.data.items[sid]) { this.data.items[sid] = this.data.items[sid].filter(function (it) { return !it.done; }); this._changed(); } };

  TodoStore.prototype.reorder = function (sid, ids) {
    if (!this.data.items[sid]) return;
    var byId = {}; this.data.items[sid].forEach(function (it) { byId[it.id] = it; });
    var next = [];
    ids.forEach(function (id) { if (byId[id]) { next.push(byId[id]); delete byId[id]; } });
    this.data.items[sid].forEach(function (it) { if (byId[it.id]) next.push(it); });
    this.data.items[sid] = next;
    this._changed();
  };

  // ---- subtasks ----
  TodoStore.prototype.addSubtask = function (sid, id, text) {
    var it = this._find(sid, id); text = (text || '').trim();
    if (!it || !text) return;
    if (!it.subtasks) it.subtasks = [];
    it.subtasks.push({ id: uid(), text: text, done: false });
    this._changed();
  };
  TodoStore.prototype.toggleSubtask = function (sid, id, subId) {
    var it = this._find(sid, id); if (!it || !it.subtasks) return;
    it.subtasks.forEach(function (s) { if (s.id === subId) s.done = !s.done; });
    this._changed();
  };
  TodoStore.prototype.editSubtask = function (sid, id, subId, text) {
    var it = this._find(sid, id); if (!it || !it.subtasks) return;
    it.subtasks.forEach(function (s) { if (s.id === subId) s.text = (text || '').trim() || s.text; });
    this._changed();
  };
  TodoStore.prototype.removeSubtask = function (sid, id, subId) {
    var it = this._find(sid, id); if (!it || !it.subtasks) return;
    it.subtasks = it.subtasks.filter(function (s) { return s.id !== subId; });
    if (!it.subtasks.length) delete it.subtasks;
    this._changed();
  };

  // ---- expiry ----
  TodoStore.prototype.purgeExpired = function () {
    var now = Date.now(), removed = 0, self = this;
    this.data.sections.forEach(function (sec) {
      var days = sec.config && sec.config.expire;
      if (!days) return;
      var max = days * 24 * 60 * 60 * 1000;
      var arr = self.data.items[sec.id] || [];
      var before = arr.length;
      self.data.items[sec.id] = arr.filter(function (it) { return !(it.done && it.doneAt && (now - it.doneAt) > max); });
      removed += before - self.data.items[sec.id].length;
    });
    if (removed) this._changed();
    return removed;
  };

  // ---- change + sync ----
  TodoStore.prototype._syncEnabled = function () { return this.backend === 'gist' && this.hasToken(); };
  TodoStore.prototype._changed = function () { this._writeCache(); this._notify(); if (this._syncEnabled()) this._scheduleSave(); };

  TodoStore.prototype.connect = function () {
    var self = this;
    if (!this._syncEnabled()) return Promise.resolve();
    return this._gistLoad().then(function () { self.purgeExpired(); self._notify(); });
  };

  TodoStore.prototype._headers = function () {
    return { 'Authorization': 'Bearer ' + this.getToken(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  };

  TodoStore.prototype._findGist = function () {
    var self = this;
    return fetch('https://api.github.com/gists?per_page=100', { headers: this._headers() })
      .then(function (res) {
        if (res.status === 401) throw new Error('Token rejected (401) — needs gist access');
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (list) {
        if (!Array.isArray(list)) return null;
        for (var i = 0; i < list.length; i++) if (list[i].files && list[i].files[self.gist.filename]) return list[i].id;
        return null;
      });
  };

  TodoStore.prototype._fetchGist = function (id) {
    var self = this;
    return fetch('https://api.github.com/gists/' + id, { headers: this._headers() }).then(function (res) {
      if (res.status === 404) { self.setGistId(''); return null; }
      if (res.status === 401) throw new Error('Token rejected (401) — needs gist access');
      if (!res.ok) throw new Error('Load failed (' + res.status + ')');
      return res.json();
    });
  };

  TodoStore.prototype._applyGist = function (json) {
    if (json && json.files) {
      var file = json.files[this.gist.filename];
      if (file && file.content) { this.data = normalize(JSON.parse(file.content)); this._writeCache(); }
    }
    this._status('idle', 'Synced');
  };

  TodoStore.prototype._gistLoad = function () {
    var self = this;
    this._status('syncing', 'Loading…');
    var resolveId = this.getGistId()
      ? Promise.resolve(this.getGistId())
      : this._findGist().then(function (fid) { if (fid) self.setGistId(fid); return fid; });
    return resolveId.then(function (id) {
      if (!id) { self._status('idle', 'No gist yet'); return; }
      return self._fetchGist(id).then(function (json) {
        if (json !== null) { self._applyGist(json); return; }
        return self._findGist().then(function (fid) {
          if (!fid) { self._status('idle', 'No gist yet'); return; }
          self.setGistId(fid);
          return self._fetchGist(fid).then(function (j) { self._applyGist(j); });
        });
      });
    });
  };

  TodoStore.prototype._scheduleSave = function () {
    var self = this;
    this._dirty = true;
    this._status('syncing', 'Saving…');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () { self._gistSave(); }, 1000);
  };

  TodoStore.prototype._gistSave = function () {
    var self = this;
    if (this._saving) { this._scheduleSave(); return; }
    this._saving = true; this._dirty = false;

    var id = this.getGistId();
    var files = {};
    files[this.gist.filename] = { content: JSON.stringify(this.data, null, 2) };
    var req = id
      ? fetch('https://api.github.com/gists/' + id, { method: 'PATCH', headers: this._headers(), body: JSON.stringify({ files: files }) })
      : fetch('https://api.github.com/gists', { method: 'POST', headers: this._headers(), body: JSON.stringify({ description: this.gist.description, public: false, files: files }) });

    req.then(function (res) {
      if (res.status === 401) throw new Error('Token rejected (401) — needs gist access');
      if (res.status === 404 && id) { self.setGistId(''); throw new Error('Gist missing — will recreate'); }
      if (!res.ok) throw new Error('Save failed (' + res.status + ')');
      return res.json();
    }).then(function (json) {
      if (json && json.id) self.setGistId(json.id);
      self._saving = false;
      if (self._dirty) self._scheduleSave(); else self._status('idle', 'Saved');
    }).catch(function (err) {
      self._saving = false;
      self._status('error', (err && err.message) || 'Save failed');
    });
  };

  // ---- normalize (shape guard + v1 migration) ----
  function normLinks(it) {
    var links = [];
    if (Array.isArray(it.links)) {
      links = it.links.filter(function (l) { return l && l.url; }).map(function (l) {
        var o = { url: String(l.url) }; if (l.label) o.label = String(l.label); return o;
      });
    } else if (typeof it.url === 'string' && it.url) {
      links = [{ url: it.url }];
    }
    return links;
  }

  function normItem(it, sec) {
    if (!it || !it.text) return null;
    var item = { id: it.id || uid(), text: String(it.text), done: !!it.done };
    if (item.done && it.doneAt) item.doneAt = Number(it.doneAt) || undefined;
    item.priority = Math.max(0, Math.min(3, parseInt(it.priority, 10) || 0));
    if (it.color) item.color = String(it.color);
    var links = normLinks(it); if (links.length) item.links = links;
    if (typeof it.notes === 'string' && it.notes) item.notes = it.notes;
    if (Array.isArray(it.subtasks)) {
      var subs = it.subtasks.filter(function (s) { return s && s.text; })
        .map(function (s) { return { id: s.id || uid(), text: String(s.text), done: !!s.done }; });
      if (subs.length) item.subtasks = subs;
    }
    if (it.recur === 'daily' || it.recur === 'weekly' || it.recur === 'monthly') item.recur = it.recur;
    if (sec.config && sec.config.term) item.term = it.term === 'now' ? 'now' : 'later';
    if (sec.config && sec.config.due) item.due = typeof it.due === 'string' ? it.due : '';
    return item;
  }

  function normSection(s) {
    var d = { id: s.id || (slug(s.name) + '-' + Math.random().toString(36).slice(2, 6)),
      name: String(s.name || 'Section'), accent: /^#/.test(s.accent) ? s.accent : '#5df2c9',
      icon: typeof s.icon === 'string' ? s.icon : '', kind: s.kind === 'tasks' ? 'tasks' : 'simple',
      config: {} };
    var c = s.config || {};
    d.config.term = !!c.term;
    d.config.due = !!c.due;
    d.config.expire = Math.max(0, parseInt(c.expire, 10) || 0);
    d.config.sort = c.sort === 'priority' ? 'priority' : 'manual';
    return d;
  }

  function normalize(d) {
    if (!d || typeof d !== 'object') return emptyData();

    // v1 migration
    if (!Array.isArray(d.sections) && (Array.isArray(d.todo) || Array.isArray(d.shopping) || Array.isArray(d.bucket))) {
      var out1 = emptyData();
      out1.sections.forEach(function (sec) {
        var arr = Array.isArray(d[sec.id]) ? d[sec.id] : [];
        out1.items[sec.id] = arr.map(function (it) { return normItem(it, sec); }).filter(Boolean);
      });
      return out1;
    }

    var out = { version: 2, sections: [], items: {} };
    var sections = (Array.isArray(d.sections) && d.sections.length) ? d.sections : defaultSections();
    sections.forEach(function (s) {
      var sec = normSection(s);
      out.sections.push(sec);
      var arr = (d.items && Array.isArray(d.items[sec.id])) ? d.items[sec.id] : [];
      out.items[sec.id] = arr.map(function (it) { return normItem(it, sec); }).filter(Boolean);
    });
    return out;
  }

  global.TodoStore = TodoStore;
})(window);
