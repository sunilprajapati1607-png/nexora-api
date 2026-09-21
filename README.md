This branch exists for one reason.

GitHub disables scheduled workflows after 60 days without
repository activity. The keepalive workflow writes here once a
week so its own schedule is never switched off. Nothing reads
this file, and it is deliberately NOT on main, because a push
to main redeploys the licence service.

last ping: 2026-09-21 02:38 UTC
