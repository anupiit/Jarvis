# Live run 1 — verifier correction

* Generation: GENERATED, 3/3 files valid on first attempt, 222 s, 3 transient HTTP 503 recovered by retry.
* `e2e-todo.json` records **16/18** browser checks. Both failures ("task B can be deleted",
  "deleted task B stays deleted") were caused by the **verifier**, not the app: its heuristic chose
  `div.todo-item-content` (text + checkbox) as the task item, while the app's `button.btn-delete`
  sits next to it inside the `<li>`, so the verifier never clicked delete.
* A direct Playwright check using the app's own selectors confirmed delete works and persists.
* The verifier was rewritten (ancestor walk + untouched sentinel task) and validated on the reference
  app (23/23) and three broken variants (each fails only its broken behaviour).
  `verification-fixed-verifier.json` = this app re-verified with the fixed verifier: **23/23**.
* `app/` is the exact output of this run.
