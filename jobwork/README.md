# nexora-jobwork-api — Nexora AI for Nexora Jobwork

A Render web service of its own (not the weight calculator's `nexora-api`), in the `jobwork/`
folder of this repository. No database, no dependencies: it carries a question from Nexora Jobwork
to Google Gemini and a checked answer back.

| Route | What |
|---|---|
| `GET /health` | alive; `ai.configured`, the model in use |
| `POST /v1/ai/assist` | `{ device, lang, assist }` → `{ answer, transcript, lang, steps, dropped }` |

**Render:** build `cd jobwork && npm install`, start `cd jobwork && npm start`.

**Environment**

* `GEMINI_API_KEY` — the Google AI Studio key named **"nexora jobwork"**. Set only in the Render
  dashboard; never in git, never in the application.
* `GEMINI_MODEL` (optional) — default `gemini-3.5-flash-lite`; the newest Flash-Lite the key lists
  is used if that one is gone, and a model Google retires mid-request is replaced by the one it names.
* `AI_DAILY_PER_DEVICE` (default 60), `AI_PER_MINUTE` (default 10).

**Never sent to Google:** party names, item names, rates, prices, amounts, costs. The application
sends parties as `P1…` and items as `I1…`; this service drops any party/item field that is not
such a token, and has no money field in its whitelist. `node test.mjs` proves it with a fake
Google that records every request body.
