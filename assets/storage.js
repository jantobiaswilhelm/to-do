/*
 * storage.js — data model + persistence for the personal to-do site.
 *
 * Exposes a single global `TodoStore` (plain script, no modules) so the
 * preview files work when opened directly via file://.
 *
 * Two backends behind one interface:
 *   - 'local'  : browser localStorage (used by the design previews)
 *   - 'github' : reads/writes data.json in the repo via the GitHub REST API,
 *                giving cross-device sync (used by the final index.html)
 *
 * Lists: todo (items have term 'now' | 'later'), shopping, bucket.
 */
(function (global) {
  'use strict';

  var LISTS = ['todo', 'shopping', 'bucket'];
  // Completed items in these lists are auto-removed a week after being ticked off.
  var EXPIRE_LISTS = ['todo', 'shopping'];
  var EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

  function emptyData() {
    return { version: 1, todo: [], shopping: [], bucket: [] };
  }

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // base64 <-> UTF-8 (handles non-ASCII characters in list text)
  function b64encode(str) {
    return global.btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64) {
    return decodeURIComponent(escape(global.atob(b64.replace(/\n/g, ''))));
  }

  function TodoStore(options) {
    options = options || {};
    this.backend = options.backend || 'local';
    this.cacheKey = options.cacheKey || 'todo-data';
    this.onChange = options.onChange || function () {};
    this.onStatus = options.onStatus || function () {};

    // Token (shared by the github + gist backends), stored in localStorage.
    this.tokenKey = options.tokenKey || 'todo-gh-token';

    // GitHub repo-contents config
    this.gh = {
      owner: (options.github && options.github.owner) || 'jantobiaswilhelm',
      repo: (options.github && options.github.repo) || 'to-do',
      branch: (options.github && options.github.branch) || 'main',
      path: (options.github && options.github.path) || 'data.json'
    };

    // Secret-gist config (the final site uses this backend)
    this.gist = {
      filename: (options.gist && options.gist.filename) || 'todo-data.json',
      description: (options.gist && options.gist.description) || 'Personal to-do site data',
      idKey: (options.gist && options.gist.idKey) || 'todo-gist-id'
    };

    this.data = emptyData();
    this.sha = null;            // current data.json sha (github backend)
    this._saveTimer = null;
    this._saving = false;
    this._dirty = false;
  }

  TodoStore.LISTS = LISTS;

  TodoStore.prototype._notify = function () {
    try { this.onChange(this.data); } catch (e) { /* noop */ }
  };
  TodoStore.prototype._status = function (state, message) {
    try { this.onStatus(state, message); } catch (e) { /* noop */ }
  };

  // ---- token helpers (github + gist backends) ----
  TodoStore.prototype.getToken = function () {
    return global.localStorage.getItem(this.tokenKey) || '';
  };
  TodoStore.prototype.setToken = function (token) {
    if (token) global.localStorage.setItem(this.tokenKey, token);
    else global.localStorage.removeItem(this.tokenKey);
  };
  TodoStore.prototype.hasToken = function () {
    return !!this.getToken();
  };

  // ---- gist id helpers ----
  TodoStore.prototype.getGistId = function () {
    return global.localStorage.getItem(this.gist.idKey) || '';
  };
  TodoStore.prototype.setGistId = function (id) {
    if (id) global.localStorage.setItem(this.gist.idKey, id);
    else global.localStorage.removeItem(this.gist.idKey);
  };
  TodoStore.prototype.gistUrl = function () {
    var id = this.getGistId();
    return id ? 'https://gist.github.com/' + id : '';
  };

  // ---- load ----
  TodoStore.prototype.init = function () {
    var self = this;
    // Always seed from the local cache first for an instant render.
    this._loadCache();
    this.purgeExpired();
    this._notify();

    if (this._syncEnabled()) {
      var loader = this.backend === 'gist' ? this._gistLoad() : this._githubLoad();
      return loader.then(function () {
        self.purgeExpired();
        self._notify();
      }).catch(function (err) {
        self._status('error', (err && err.message) || 'Sync load failed');
      });
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

  // ---- mutations ----
  TodoStore.prototype.get = function (list) {
    return this.data[list] ? this.data[list].slice() : [];
  };

  TodoStore.prototype.add = function (list, text, extra) {
    text = (text || '').trim();
    if (!text || !this.data[list]) return null;
    var item = { id: uid(), text: text, done: false };
    if (extra) for (var k in extra) item[k] = extra[k];
    this.data[list].push(item);
    this._changed();
    return item;
  };

  TodoStore.prototype.toggle = function (list, id) {
    var it = this._find(list, id);
    if (it) {
      it.done = !it.done;
      if (it.done) it.doneAt = Date.now();   // start the 1-week expiry clock
      else delete it.doneAt;
      this._changed();
    }
  };

  // Remove completed todo/shopping items ticked off more than a week ago.
  TodoStore.prototype.purgeExpired = function () {
    var now = Date.now(), removed = 0, self = this;
    EXPIRE_LISTS.forEach(function (list) {
      var before = self.data[list].length;
      self.data[list] = self.data[list].filter(function (it) {
        return !(it.done && it.doneAt && (now - it.doneAt) > EXPIRE_MS);
      });
      removed += before - self.data[list].length;
    });
    if (removed) this._changed();
    return removed;
  };

  TodoStore.prototype.edit = function (list, id, text) {
    var it = this._find(list, id);
    if (it) { it.text = (text || '').trim() || it.text; this._changed(); }
  };

  TodoStore.prototype.setTerm = function (list, id, term) {
    var it = this._find(list, id);
    if (it) { it.term = term; this._changed(); }
  };

  TodoStore.prototype.setDue = function (list, id, due) {
    var it = this._find(list, id);
    if (it) { it.due = due || ''; this._changed(); }
  };

  TodoStore.prototype.setPriority = function (list, id, priority) {
    var it = this._find(list, id);
    if (it) { it.priority = Math.max(0, Math.min(3, priority | 0)); this._changed(); }
  };

  TodoStore.prototype.remove = function (list, id) {
    if (!this.data[list]) return;
    this.data[list] = this.data[list].filter(function (it) { return it.id !== id; });
    this._changed();
  };

  TodoStore.prototype.clearDone = function (list) {
    if (!this.data[list]) return;
    this.data[list] = this.data[list].filter(function (it) { return !it.done; });
    this._changed();
  };

  TodoStore.prototype._find = function (list, id) {
    if (!this.data[list]) return null;
    for (var i = 0; i < this.data[list].length; i++) {
      if (this.data[list][i].id === id) return this.data[list][i];
    }
    return null;
  };

  TodoStore.prototype._syncEnabled = function () {
    return (this.backend === 'github' || this.backend === 'gist') && this.hasToken();
  };

  TodoStore.prototype._changed = function () {
    this._writeCache();
    this._notify();
    if (this._syncEnabled()) this._scheduleSave();
  };

  // Called by the UI after the user enters/changes a token.
  TodoStore.prototype.connect = function () {
    var self = this;
    if (!this._syncEnabled()) return Promise.resolve();
    var loader = this.backend === 'gist' ? this._gistLoad() : this._githubLoad();
    return loader.then(function () { self.purgeExpired(); self._notify(); });
  };

  // ---- github sync ----
  TodoStore.prototype._apiUrl = function () {
    return 'https://api.github.com/repos/' + this.gh.owner + '/' + this.gh.repo +
      '/contents/' + this.gh.path;
  };

  TodoStore.prototype._headers = function () {
    return {
      'Authorization': 'Bearer ' + this.getToken(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  };

  TodoStore.prototype._githubLoad = function () {
    var self = this;
    this._status('syncing', 'Loading…');
    return fetch(this._apiUrl() + '?ref=' + this.gh.branch, { headers: this._headers() })
      .then(function (res) {
        if (res.status === 404) { self.sha = null; self._status('idle', 'No remote yet'); return null; }
        if (res.status === 401) throw new Error('Token rejected (401) — check the token');
        if (!res.ok) throw new Error('Load failed (' + res.status + ')');
        return res.json();
      })
      .then(function (json) {
        if (!json) return;
        self.sha = json.sha;
        var remote = normalize(JSON.parse(b64decode(json.content)));
        self.data = remote;
        self._writeCache();
        self._status('idle', 'Synced');
      });
  };

  TodoStore.prototype._scheduleSave = function () {
    var self = this;
    this._dirty = true;
    this._status('syncing', 'Saving…');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () {
      if (self.backend === 'gist') self._gistSave();
      else self._githubSave();
    }, 1000);
  };

  TodoStore.prototype._githubSave = function () {
    var self = this;
    if (this._saving) { this._scheduleSave(); return; }
    this._saving = true;
    this._dirty = false;

    var body = {
      message: 'Update lists',
      content: b64encode(JSON.stringify(this.data, null, 2)),
      branch: this.gh.branch
    };
    if (this.sha) body.sha = this.sha;

    fetch(this._apiUrl(), {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 409) {
        // stale sha — reload remote then re-save our local copy (last write wins)
        return self._githubLoad().then(function () { self._dirty = true; throw { conflict: true }; });
      }
      if (res.status === 401) throw new Error('Token rejected (401)');
      if (!res.ok) return res.text().then(function (t) { throw new Error('Save failed (' + res.status + ')'); });
      return res.json();
    }).then(function (json) {
      if (json && json.content) self.sha = json.content.sha;
      self._saving = false;
      if (self._dirty) self._scheduleSave();
      else self._status('idle', 'Saved');
    }).catch(function (err) {
      self._saving = false;
      if (err && err.conflict) { self._scheduleSave(); return; }
      self._status('error', (err && err.message) || 'Save failed');
    });
  };

  // ---- gist sync (secret gist) ----
  TodoStore.prototype._gistLoad = function () {
    var self = this;
    var id = this.getGistId();
    if (!id) { this._status('idle', 'No gist yet'); return Promise.resolve(); }
    this._status('syncing', 'Loading…');
    return fetch('https://api.github.com/gists/' + id, { headers: this._headers() })
      .then(function (res) {
        if (res.status === 404) { self.setGistId(''); self._status('idle', 'Gist not found'); return null; }
        if (res.status === 401) throw new Error('Token rejected (401) — needs gist access');
        if (!res.ok) throw new Error('Load failed (' + res.status + ')');
        return res.json();
      })
      .then(function (json) {
        if (!json || !json.files) return;
        var file = json.files[self.gist.filename];
        if (!file || !file.content) return;
        self.data = normalize(JSON.parse(file.content));
        self._writeCache();
        self._status('idle', 'Synced');
      });
  };

  TodoStore.prototype._gistSave = function () {
    var self = this;
    if (this._saving) { this._scheduleSave(); return; }
    this._saving = true;
    this._dirty = false;

    var id = this.getGistId();
    var files = {};
    files[this.gist.filename] = { content: JSON.stringify(this.data, null, 2) };

    var req = id
      ? fetch('https://api.github.com/gists/' + id, {
          method: 'PATCH', headers: this._headers(), body: JSON.stringify({ files: files })
        })
      : fetch('https://api.github.com/gists', {
          method: 'POST', headers: this._headers(),
          body: JSON.stringify({ description: this.gist.description, public: false, files: files })
        });

    req.then(function (res) {
      if (res.status === 401) throw new Error('Token rejected (401) — needs gist access');
      if (res.status === 404 && id) { self.setGistId(''); throw new Error('Gist missing — will recreate'); }
      if (!res.ok) throw new Error('Save failed (' + res.status + ')');
      return res.json();
    }).then(function (json) {
      if (json && json.id) self.setGistId(json.id);
      self._saving = false;
      if (self._dirty) self._scheduleSave();
      else self._status('idle', 'Saved');
    }).catch(function (err) {
      self._saving = false;
      self._status('error', (err && err.message) || 'Save failed');
    });
  };

  // ---- shape guard ----
  function normalize(d) {
    var out = emptyData();
    if (d && typeof d === 'object') {
      LISTS.forEach(function (list) {
        if (Array.isArray(d[list])) {
          out[list] = d[list].filter(function (it) { return it && it.text; }).map(function (it) {
            var item = { id: it.id || uid(), text: String(it.text), done: !!it.done };
            if (item.done && it.doneAt) item.doneAt = Number(it.doneAt) || undefined;
            if (list === 'todo') {
              item.term = it.term === 'now' ? 'now' : 'later';
              item.due = typeof it.due === 'string' ? it.due : '';
              item.priority = Math.max(0, Math.min(3, parseInt(it.priority, 10) || 0));
            }
            return item;
          });
        }
      });
    }
    return out;
  }

  global.TodoStore = TodoStore;
})(window);
