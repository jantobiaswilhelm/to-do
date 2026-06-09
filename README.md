# Personal To-Do

A small personal productivity website with three areas:

- **To-Do** — general things to handle (taxes, send a letter…) plus short-term tasks for **today / this week**. Each task can have a **due date** and a **0–3 star priority**, and the list sorts itself (open first, then by priority, then by due date).
- **Shopping list** — things to buy.
- **Bucket list** — activities and longer-term goals.

Completed **To-Do** and **Shopping** items are cleared automatically **one week after they're ticked off** (Bucket list items are kept).

Dark UI with a colour per section. Static site, hostable on **GitHub Pages**, with data **synced across devices** via a private GitHub gist.

`index.html` is the live site. The `previews/` folder holds the three design explorations (minimal / colorful / dark) and can be deleted.

## How sync works

GitHub Pages can't run a server, so the site stores your lists in a **secret gist**
(unlisted, private to your account — *not* in this public repo) through the GitHub
REST API, using a personal access token you enter once. The gist is created
automatically on first use. The token is stored only in your browser
(`localStorage`) and is sent only to `api.github.com`.

### Connecting (click ⚙ on the site)

1. Create a token. It only needs **gist** access — no repository access at all:
   - **Classic token** (simplest): tick the single **`gist`** scope. The ⚙ panel links
     straight to this pre-filled page.
   - **Fine-grained token**: Account permissions → **Gists: Read and write**.
2. Paste it into the panel and click **Connect**.
3. A secret gist named `todo-data.json` is created and kept in sync. Use the same
   token on another device to see the same lists.

## Deploy to GitHub Pages

1. Push to `main`.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `/ (root)`.
3. Site goes live at `https://jantobiaswilhelm.github.io/to-do/`.

## ⚠️ Privacy

Your lists live in a **secret gist**, so they are **not** exposed in this public
repo — the repo only contains the app code. Secret gists are unlisted but not
encrypted; anyone with the gist URL could read it, so don't share it.

## Files

```
index.html          # the live site (dark + colourful)
assets/storage.js   # data model + localStorage / gist sync + expiry
assets/app.js       # rendering, due dates, priority, sorting, sync panel
```
