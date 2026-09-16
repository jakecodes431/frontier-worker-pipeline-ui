# Example worker brief: tags routes for notes-app

> This is the `tags-api` task from [`example-orchestrator.md`](example-orchestrator.md),
> written the way an orchestrator would write it. Everything the worker needs is here;
> there is nothing to ask about. Spawn it with:
>
> ```
> node bin/cr.js spawn --name "tags-api" --role worker --runtime deepseek \
>   --repo /path/to/notes-app \
>   --task "Add the /api/tags routes and ?tag= filtering to GET /api/notes" \
>   --brief-file briefs/example-worker.md
> ```

## Goal

Expose the tag storage layer over HTTP. When you are finished, a client can list the
current user's tags, add a tag to a note, remove a tag from a note, and ask for only the
notes carrying one tag. Nothing else changes: same response shapes, same status codes,
same auth behaviour as the rest of the API.

## What already exists (do not rewrite it)

`server/db/tags.js` is already merged on your base branch and is the only storage you may
use. Its exact interface:

```js
listTags(userId)                  // -> [{ id, name, noteCount }], name ascending
addTagToNote(userId, noteId, name) // -> { id, name }; creates the tag if new; idempotent
removeTagFromNote(userId, noteId, tagId) // -> true if a row was removed, false if not
listNotes(userId, { tag })         // existing function, now accepts an optional tag name
```

Tag names are normalised by the storage layer (trimmed, lowercased). Do not normalise
them again in the route. All four functions are synchronous and throw `NotFoundError`
(exported from `server/db/errors.js`) when the note does not belong to `userId`.

## Routes to add

Follow the existing style in `server/routes/notes.js` exactly — same router factory, same
`asyncHandler`, same error middleware, same `req.user.id` for the current user.

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/tags` | — | `200 { tags: [...] }` | — |
| POST | `/api/notes/:noteId/tags` | `{ "name": "recipes" }` | `201 { tag: {...} }` | `400` empty or >32 chars; `404` unknown note |
| DELETE | `/api/notes/:noteId/tags/:tagId` | — | `204` no body | `404` unknown note or tag not on it |

Also extend the existing `GET /api/notes` with an optional `?tag=` query parameter: pass
it through to `listNotes(userId, { tag })` unchanged, and keep the current response shape.
An unknown tag is not an error — it returns an empty list. `NotFoundError` maps to 404
through the existing error middleware; do not catch it in the handler.

## Files in scope

Create or edit only these, all relative to the repo root:

- `server/routes/tags.js` — new router.
- `server/routes/notes.js` — the `?tag=` pass-through only; touch nothing else in it.
- `server/routes/index.js` — mount the new router next to the existing ones.
- `server/routes/tags.test.js` — new tests (see below).

## What not to touch

- `server/db/**` — the storage layer is finished and owned by another task.
- `ui/**` and `docs/**` — other workers are editing those right now.
- `package.json`, lockfiles, lint or build config. Add no dependencies.
- No reformatting, no renaming, no "while I was in here" cleanups anywhere.

## Tests to write

In `server/routes/tags.test.js`, using the existing helpers in `server/test/helpers.js`
(`withTestServer`, `seedUser`, `seedNote`):

1. `GET /api/tags` returns the seeded user's tags and not another user's.
2. `POST /api/notes/:noteId/tags` creates a new tag, returns 201, and is idempotent when
   posted twice.
3. `POST` with `{ "name": "" }` returns 400.
4. `DELETE` removes the tag from the note and returns 204; deleting it again returns 404.
5. `GET /api/notes?tag=recipes` returns only the tagged notes, and `?tag=nope` returns
   an empty list with status 200.
6. A note belonging to another user returns 404 for both `POST` and `DELETE`.

## Proof command

One command, judged by its exit code:

```
npm run lint && npm test
```

Run `npm install` first if `node_modules` is missing. Run the proof command yourself and
keep running it until it exits 0. If it cannot pass for a reason outside your files, stop
and say so in your final message instead of editing files outside the scope list.

## Definition of done

- The four files above exist with the described behaviour and nothing else is modified
  (`git status --short` shows only those paths).
- `npm run lint && npm test` exits 0.
- Your work is committed on your own branch with a one-line subject and a body that names
  WHAT changed, WHY, and the PROOF command output.
- You reported once: `node $CR_BIN report "tags-api: gate green, 6 tests added"`
  (`$env:CR_BIN` in PowerShell). You do not need to set a status — exiting 0 marks you
  done.
- Your final message, which is what your orchestrator reads, is exactly:

```
FILES   <the paths you changed>
PROOF   <the command, and the last few lines of its output>
NOTES   <anything surprising, or "none">
```
