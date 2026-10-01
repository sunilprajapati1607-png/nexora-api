# Nexora database backup

Owner's decision, 2026-10-01: the database is backed up to **"GitHub (private, encrypted)"**.

The workflow is `.github/workflows/db-backup.yml` in this repository (`nexora-api`, private). It
runs **every night at 02:00 IST** and can be run by hand at any time.

*ગુજરાતી નીચે છે — [ગુજરાતી](#ગુજરાતી).*

---

## English

### What it does

1. `pg_dump` (PostgreSQL 17) of everything Nexora owns in the Supabase database
   (project `dzbzcwmxyenztowzcukc`, Mumbai):
   * schema `public` — licences, companies, company users, every synced record (masters,
     quotations, enquiries, approvals …), chat, feedback, enquiries, app releases, ink models
   * schema `ops` — the keepalive heartbeat
2. Checks it is a real backup: at least 10 KB, the core tables are in it
   (`companies`, `company_users`, `licences`, `sync_records`), and there is at least one company.
3. Encrypts it with **AES-256** (`gpg --symmetric`) under your passphrase, then decrypts it again
   on the spot to prove the passphrase opens it.
4. Keeps the encrypted file as a GitHub **artifact** named `nexora-db-YYYY-MM-DD` for **30 days**.
5. Restores the dump into a throwaway PostgreSQL 17 on GitHub's machine and checks every table has
   the same number of rows. A backup nobody has restored is only a hope.

The log shows only sizes, table names and row counts — never the connection string, the passphrase
or any data. The run's **Summary** page shows a table of rows per table.

**Not in the backup** (on purpose): Supabase's own schemas (auth, storage, realtime, vault, cron,
net). Nexora keeps nothing it needs there; a new Supabase project creates them itself. The two
`pg_cron` jobs are listed under *Disaster recovery* below. Render's environment variables
(`DATABASE_URL`, `NEXORA_TOKEN_SECRET`, `NEXORA_ADMIN_KEY`, `GEMINI_API_KEY`) are not in the
database either — keep a copy of them in your password manager.

### One-time setup: two secrets

Open **https://github.com/sunilprajapati1607-png/nexora-api** → **Settings** →
**Secrets and variables** → **Actions** → **New repository secret**. Add these two (the names must
be exactly these):

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | the **Session pooler** connection string of the Supabase project |
| `BACKUP_PASSPHRASE` | a long random phrase (at least 20 characters; 32+ is better) |

**`SUPABASE_DB_URL` — where to copy it**

1. Supabase dashboard → project **dzbzcwmxyenztowzcukc** → **Connect** (button at the top of the
   project page). On older dashboards: **Project Settings → Database → Connection string**.
2. Type **URI**, method **Session pooler**. It looks like
   `postgresql://postgres.dzbzcwmxyenztowzcukc:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
3. Replace `[YOUR-PASSWORD]` (brackets too) with the database password.

* It must be the **Session pooler** (port **5432**, host ending `pooler.supabase.com`). The
  *Transaction pooler* (port 6543) cannot run `pg_dump`, and the *Direct connection*
  (`db.….supabase.co`) is IPv6-only, which GitHub's machines do not have. The workflow refuses
  6543 with a clear message.
* **Easiest:** Render dashboard → service **nexora-api** → **Environment** → `DATABASE_URL` already
  holds the right user and password. If its host ends in `pooler.supabase.com` and its port is
  5432, copy it as is. If the port is 6543, copy it and change only `6543` to `5432`.
* **Do not reset the database password just for this** — resetting it stops the live service until
  Render's `DATABASE_URL` is updated too.
* If the password has any of `@ : / ? # %` in it, they must be written as `%40 %3A %2F %3F %23 %25`
  in the URL (a copy of Render's working `DATABASE_URL` already is). The workflow refuses a URL
  where `@ / ? #` or a bare `%` is left unencoded, and it hides the password in the log on its own.

**`BACKUP_PASSPHRASE`**

* Make it with your password manager's generator — 32 or more random characters.
* Keep it in the password manager **and** on paper in a safe place. **If it is lost, every backup
  is unreadable — nobody, not GitHub and not Claude, can open them.** GitHub never shows a secret
  again after it is saved.
* Do not change it casually. If you ever do, keep the old one for 30 days: older artifacts stay
  under the old passphrase until they expire.

### Run it by hand

**Actions** tab → **DB backup** (left list) → **Run workflow** → branch **main** → **Run workflow**.

After 3–5 minutes the run turns green. Open it: the **Summary** shows the row counts, and at the
bottom under **Artifacts** is `nexora-db-YYYY-MM-DD` (a zip holding one `.dump.gpg` file).

The workflow appears in the Actions tab once this file is on `main`. Do one manual run right after
adding the secrets.

### When it fails

GitHub emails you when a scheduled run fails. Open the run and read the red step:

| Message | What to do |
|---|---|
| `SUPABASE_DB_URL is not set` / `BACKUP_PASSPHRASE is not set` | add the secret (above) |
| `TRANSACTION pooler (port 6543)` | change the port in the secret to 5432 |
| `pg_dump failed three times` | Supabase project paused, or the database password changed — check Supabase, then update the secret |
| `server version mismatch` | Supabase upgraded PostgreSQL — change `PG_IMAGE: postgres:17` to the new major (one line) in `db-backup.yml` |
| `raw @ / ? or #` / `% that is not followed by two hex digits` | the password in the secret is not %-encoded — write `@ / ? # %` as `%40 %2F %3F %23 %25` (see *One-time setup*) and save the secret again |
| `the dump is only … bytes` / `holds no companies` | the database is empty or broken — **do not wait**, look at Supabase now; older backups are still in Actions for 30 days |
| `Restore test: FAILED` / `throwaway PostgreSQL` | tonight's file **was** kept, but restore it by hand (below) before trusting it, and ask for the workflow to be checked. **Re-run failed jobs** is safe: it replaces that night's artifact with a fresh, checked one |

Cost: about 3–5 minutes of GitHub Actions a night (≈150 of the 2,000 free minutes a month for a
private repository) and well under 1 MB of artifact storage per night.

### Restore into a scratch Supabase project (step by step)

Do this for the monthly test, and before ever trusting a backup for real.

**Tools on the PC (one time)**

* **Git Bash** — already installed (`C:\Program Files\Git\git-bash.exe`); it includes `gpg`.
  (Or install Gpg4win and use Kleopatra: right-click the file → *Decrypt*.)
* **PostgreSQL 17 command-line tools** — the EDB Windows installer for PostgreSQL 17
  (enterprisedb.com → Download PostgreSQL → 17 → Windows x86-64); on *Select Components* tick
  **only "Command Line Tools"**. They land in `C:\Program Files\PostgreSQL\17\bin\`.

**Steps**

1. **Scratch project:** Supabase dashboard → **New project** → name `nexora-restore-test`, region
   **Mumbai (ap-south-1)**, a new database password (write it down for today). If the form shows
   **Security options**, choose **Only Connection String** — the scratch copy then has no Data API
   at all. Wait until it is ready. Then **Database → Extensions** → enable **pg_net** (the `ops`
   functions call it).

   Then, **before restoring anything**, **SQL Editor** → run this. A new Supabase project hands
   every table its `postgres` user creates to the API roles (`anon`, `authenticated`), so without
   it the restored companies, users, enquiries and chat could be read by anyone holding the
   project's anon key:

   ```sql
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
   ```

2. **Download:** GitHub → Actions → DB backup → the newest green run → **Artifacts** →
   `nexora-db-YYYY-MM-DD`. Make the folder `D:\nexora-restore` and unzip it there, so you have
   `D:\nexora-restore\nexora-db-YYYY-MM-DD_HHMMIST.dump.gpg`.
3. **Open Git Bash** and decrypt (it asks for `BACKUP_PASSPHRASE`):

   ```bash
   cd /d/nexora-restore
   gpg --pinentry-mode loopback --output nexora.dump --decrypt nexora-db-*.dump.gpg
   ```

4. **Make the restore list** — everything except the `public` schema itself, which every database
   already has:

   ```bash
   PGR="/c/Program Files/PostgreSQL/17/bin/pg_restore.exe"
   "$PGR" --list nexora.dump \
     | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > restore.list
   ```

5. **Restore** into the scratch project. Copy the **scratch** project's own *Session pooler* URI
   (Connect → URI → Session pooler) and delete `:[YOUR-PASSWORD]` from it; the password is typed
   separately so it is not kept in the shell history:

   ```bash
   read -rsp 'Scratch database password: ' PGPASSWORD; echo; export PGPASSWORD
   "$PGR" --no-owner --no-privileges --use-list=restore.list \
     --dbname='postgresql://postgres.SCRATCH_REF@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' \
     nexora.dump
   unset PGPASSWORD
   ```

   (Put the scratch project's own `SCRATCH_REF` and host — copy them from its Session pooler URI.)
   No output means success. `errors ignored on restore: N` means something did not restore — read
   the lines above it.
6. **Lock, then check:** scratch project → **SQL Editor** → run this first. Row-level security
   comes back only for the tables that had it on the live database, and four tables added after
   the move to Supabase (`inquiries`, `feedback`, `app_releases`, `chat_messages`) never had it —
   so turn it on for every table, and take away any API access left over:

   ```sql
   DO $$
   DECLARE t text;
   BEGIN
     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
     END LOOP;
   END $$;
   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;
   ```

   Every row of the last result must say `true`. (Nexora's own service is the tables' owner, so
   row-level security does not stop it.) Then run

   ```sql
   SELECT 'companies' AS t, count(*) FROM companies     UNION ALL
   SELECT 'company_users',  count(*) FROM company_users UNION ALL
   SELECT 'licences',       count(*) FROM licences      UNION ALL
   SELECT 'sync_records',   count(*) FROM sync_records;
   ```

   The numbers must match the row table on that run's **Summary** page.
7. **Clean up the same day:** delete `D:\nexora-restore\nexora.dump` and
   `D:\nexora-restore\restore.list` (the `.dump` is every company's data, readable), and delete the
   scratch project (**Project Settings → General → Delete project**).

### Monthly restore test

On the **first working day of every month**, do the *Restore into a scratch project* steps above
with the newest backup. The nightly run already restores into a throwaway database on GitHub; the
monthly test proves what the robot cannot: that **your** copy of the passphrase still opens the
file, that the tools on the PC still work, and that you still know the steps. Note it below.

| Date | Backup used | Tables / rows matched? | By |
|---|---|---|---|
| | | | |

### Disaster recovery (the live database is lost)

1. New Supabase project, region **Mumbai (ap-south-1)**, strong database password (into the password
   manager). Keep the Data API on here (do **not** pick *Only Connection String*) —
   `keepalive.yml` pings it. **Database → Extensions** → enable **pg_cron** and **pg_net**. Then run
   the three `ALTER DEFAULT PRIVILEGES` lines from step 1 above, **before** restoring.
2. Restore the newest backup into it — steps 2–6 above, using the new project's Session pooler URI.
   Step 6 is the lock-down: row-level security on every table and no access for the API roles,
   which Nexora never uses. Do not skip it.
3. Re-create the two scheduled jobs (SQL Editor). The schedules are the live ones, read from
   `cron.job` on 2026-10-01; pg_cron runs in UTC, so `3-12` is 08:30–18:29 IST:

   ```sql
   SELECT cron.schedule('nexora-keepalive',   '17 */6 * * *',    'SELECT ops.beat()');
   SELECT cron.schedule('nexora-wake-render', '*/10 3-12 * * *', 'SELECT ops.wake_render()');
   ```

4. Render → **nexora-api** → **Environment** → set `DATABASE_URL` to the new project's pooler
   string → save (the service restarts). Check `https://nexora-api-55jv.onrender.com/health`.
5. In this repository: update the `SUPABASE_DB_URL` secret, and the Supabase address and anon key
   in `.github/workflows/keepalive.yml`.

The desktop and phone apps talk only to Render, so nothing changes on customers' machines. Anything
written after the backup's time (at most about a day) is not in it.

---

## ગુજરાતી

### આ શું કરે છે

માલિકનો નિર્ણય, 2026-10-01: database નો backup **"GitHub (private, encrypted)"** માં રાખવો.

Workflow `.github/workflows/db-backup.yml` (આ private repository `nexora-api` માં) **દરરોજ રાત્રે
02:00 IST** એ ચાલે છે, અને જ્યારે જોઈએ ત્યારે હાથથી પણ ચલાવી શકાય છે.

1. Supabase database (project `dzbzcwmxyenztowzcukc`, Mumbai) માં Nexora નું બધું — schema
   `public` (licences, companies, users, દરેક synced record: masters, quotations, enquiries,
   approvals…, chat, feedback) અને schema `ops` (keepalive) — નો PostgreSQL 17 `pg_dump` લે છે.
2. ચકાસે છે કે backup સાચો છે: ઓછામાં ઓછો 10 KB, મુખ્ય tables (`companies`, `company_users`,
   `licences`, `sync_records`) અંદર છે, અને ઓછામાં ઓછી એક company છે.
3. તમારા passphrase થી **AES-256** માં encrypt કરે છે, અને તરત ફરી decrypt કરીને ખાતરી કરે છે કે
   એ જ passphrase થી file ખુલે છે.
4. Encrypted file ને GitHub **artifact** `nexora-db-YYYY-MM-DD` તરીકે **30 દિવસ** રાખે છે.
5. GitHub ના મશીન પર એક કામચલાઉ PostgreSQL 17 માં restore કરીને દરેક table ની rows ગણે છે.
   જે backup ક્યારેય restore નથી થયો, તે ફક્ત આશા છે.

Log માં ફક્ત size, table ના નામ અને rows ની સંખ્યા આવે છે — connection string, passphrase કે
કોઈ data ક્યારેય નહીં.

**Backup માં નથી** (જાણી જોઈને): Supabase ના પોતાના schemas (auth, storage, realtime, vault,
cron, net) — નવો Supabase project એ જાતે બનાવે છે. બે `pg_cron` jobs નીચે *Disaster recovery*
માં લખેલા છે. Render ના environment variables (`DATABASE_URL`, `NEXORA_TOKEN_SECRET`,
`NEXORA_ADMIN_KEY`, `GEMINI_API_KEY`) database માં નથી — એની નકલ password manager માં રાખો.

### એક જ વાર: બે secrets ઉમેરો

**https://github.com/sunilprajapati1607-png/nexora-api** → **Settings** →
**Secrets and variables** → **Actions** → **New repository secret**. નામ બરાબર આ જ રાખો:

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | Supabase project ની **Session pooler** connection string |
| `BACKUP_PASSPHRASE` | લાંબો random passphrase (ઓછામાં ઓછા 20 અક્ષર; 32+ વધુ સારું) |

**`SUPABASE_DB_URL` ક્યાંથી લેવી**

1. Supabase dashboard → project **dzbzcwmxyenztowzcukc** → ઉપર **Connect** બટન (જૂના dashboard
   માં: **Project Settings → Database → Connection string**).
2. Type **URI**, method **Session pooler**. આવું દેખાશે:
   `postgresql://postgres.dzbzcwmxyenztowzcukc:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
3. `[YOUR-PASSWORD]` (કૌંસ સાથે) ની જગ્યાએ database password લખો.

* **Session pooler** જ જોઈએ (port **5432**). *Transaction pooler* (port 6543) પર `pg_dump` નથી
  ચાલતો, અને *Direct connection* ફક્ત IPv6 છે જે GitHub પાસે નથી.
* **સૌથી સહેલું:** Render dashboard → **nexora-api** → **Environment** → `DATABASE_URL` માં સાચો
  user અને password પહેલેથી છે. Port 5432 હોય તો એમ જ copy કરો; 6543 હોય તો ફક્ત `6543` ને
  `5432` કરો.
* **ફક્ત આ માટે database password reset ન કરો** — reset કરવાથી Render નો `DATABASE_URL` બદલાય
  ત્યાં સુધી live service બંધ થઈ જશે.
* Password માં `@ : / ? # %` હોય તો URL માં `%40 %3A %2F %3F %23 %25` લખવું પડે (Render ની ચાલતી
  `DATABASE_URL` માં પહેલેથી એમ જ છે). `@ / ? #` કે એકલો `%` એમ ને એમ રહી જાય તો workflow એ URL
  સ્વીકારતો નથી, અને log માં password ને અલગથી પણ છુપાવે છે.

**`BACKUP_PASSPHRASE`**

* Password manager ના generator થી બનાવો — 32 કે વધુ random અક્ષર.
* Password manager માં **અને** કાગળ પર સુરક્ષિત જગ્યાએ રાખો. **એ ખોવાઈ જાય તો કોઈ backup ખૂલશે
  નહીં — GitHub કે Claude પણ ખોલી શકશે નહીં.** Save કર્યા પછી GitHub secret ફરી બતાવતું નથી.
* વગર કારણે બદલશો નહીં. બદલો તો જૂનો 30 દિવસ સાચવો — જૂના artifacts જૂના passphrase થી જ ખૂલશે.

### હાથથી ચલાવવું

**Actions** tab → ડાબી બાજુ **DB backup** → **Run workflow** → branch **main** → **Run workflow**.

3–5 મિનિટમાં run લીલો થશે. ખોલો: **Summary** માં rows ની સંખ્યા, અને નીચે **Artifacts** માં
`nexora-db-YYYY-MM-DD` (zip, અંદર એક `.dump.gpg` file).

આ file `main` પર આવે પછી જ workflow Actions માં દેખાશે. Secrets ઉમેર્યા પછી તરત એક વાર હાથથી
ચલાવો.

### Fail થાય ત્યારે

Scheduled run fail થાય તો GitHub email કરે છે. Run ખોલીને લાલ step વાંચો:

| સંદેશ | શું કરવું |
|---|---|
| `SUPABASE_DB_URL is not set` / `BACKUP_PASSPHRASE is not set` | secret ઉમેરો (ઉપર) |
| `TRANSACTION pooler (port 6543)` | secret માં port 5432 કરો |
| `pg_dump failed three times` | Supabase project pause થયો છે અથવા password બદલાયો છે — Supabase જુઓ, પછી secret update કરો |
| `server version mismatch` | Supabase એ PostgreSQL upgrade કર્યું — `db-backup.yml` માં `PG_IMAGE: postgres:17` (એક જ line) નવા version પર કરો |
| `raw @ / ? or #` / `% that is not followed by two hex digits` | secret ના password માં `@ / ? # %` ને `%40 %2F %3F %23 %25` તરીકે લખો (ઉપર *બે secrets* જુઓ) અને secret ફરી save કરો |
| `the dump is only … bytes` / `holds no companies` | database ખાલી કે ખરાબ છે — **રાહ ન જુઓ**, હમણાં Supabase જુઓ; જૂના backups 30 દિવસ Actions માં છે |
| `Restore test: FAILED` / `throwaway PostgreSQL` | આજની file **રાખી છે**, પણ ભરોસો કરતાં પહેલાં હાથથી restore કરો (નીચે) અને workflow તપાસાવો. **Re-run failed jobs** કરવામાં વાંધો નથી: એ રાતનો artifact નવા, ચકાસેલા backup થી બદલાઈ જાય છે |

ખર્ચ: રોજ 3–5 મિનિટ GitHub Actions (private repo માટે મહિને 2,000 મફત મિનિટમાંથી ≈150), અને
રોજ 1 MB કરતાં ઓછું artifact storage.

### Scratch Supabase project માં restore (પગલાં)

માસિક test માટે, અને કોઈ backup પર સાચે ભરોસો કરતાં પહેલાં આ કરો.

**PC પર tools (એક જ વાર)**

* **Git Bash** — પહેલેથી install છે (`C:\Program Files\Git\git-bash.exe`); એમાં `gpg` છે.
  (અથવા Gpg4win install કરી Kleopatra માં file પર right-click → *Decrypt*.)
* **PostgreSQL 17 command-line tools** — PostgreSQL 17 નો EDB Windows installer; *Select
  Components* માં **ફક્ત "Command Line Tools"** રાખો. એ `C:\Program Files\PostgreSQL\17\bin\` માં
  આવશે.

**પગલાં**

1. **Scratch project:** Supabase → **New project** → નામ `nexora-restore-test`, region **Mumbai
   (ap-south-1)**, નવો database password (આજ માટે લખી રાખો). Form માં **Security options** દેખાય
   તો **Only Connection String** પસંદ કરો — એટલે scratch copy માં Data API જ નહીં રહે. તૈયાર થાય
   પછી **Database → Extensions** → **pg_net** enable કરો.

   પછી, **કંઈ પણ restore કરતાં પહેલાં**, **SQL Editor** માં આ ચલાવો. નવો Supabase project એના
   `postgres` user એ બનાવેલું દરેક table API roles (`anon`, `authenticated`) ને આપી દે છે, એટલે આ
   વગર restore થયેલી companies, users, enquiries અને chat project ની anon key ધરાવનાર કોઈ પણ વાંચી
   શકે:

   ```sql
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
   ```

2. **Download:** GitHub → Actions → DB backup → સૌથી નવો લીલો run → **Artifacts** →
   `nexora-db-YYYY-MM-DD`. `D:\nexora-restore` folder બનાવીને ત્યાં unzip કરો.
3. **Git Bash** ખોલીને decrypt કરો (એ `BACKUP_PASSPHRASE` માગશે):

   ```bash
   cd /d/nexora-restore
   gpg --pinentry-mode loopback --output nexora.dump --decrypt nexora-db-*.dump.gpg
   ```

4. **Restore list** બનાવો (`public` schema પોતે છોડીને — એ દરેક database માં હોય જ છે):

   ```bash
   PGR="/c/Program Files/PostgreSQL/17/bin/pg_restore.exe"
   "$PGR" --list nexora.dump \
     | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > restore.list
   ```

5. **Restore:** scratch project ની પોતાની *Session pooler* URI copy કરો અને એમાંથી
   `:[YOUR-PASSWORD]` કાઢી નાખો; password અલગથી ટાઇપ થશે જેથી history માં ન રહે:

   ```bash
   read -rsp 'Scratch database password: ' PGPASSWORD; echo; export PGPASSWORD
   "$PGR" --no-owner --no-privileges --use-list=restore.list \
     --dbname='postgresql://postgres.SCRATCH_REF@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' \
     nexora.dump
   unset PGPASSWORD
   ```

   (`SCRATCH_REF` અને host scratch project ની URI માંથી લો.) કંઈ output ન આવે તો સફળ.
   `errors ignored on restore: N` આવે તો ઉપરની lines વાંચો.
6. **Lock કરો, પછી ચકાસો:** scratch project → **SQL Editor** → પહેલાં આ ચલાવો. Row-level
   security ફક્ત એ tables માં પાછી આવે છે જેમાં live database પર ચાલુ હતી, અને Supabase પર ગયા પછી
   ઉમેરાયેલાં ચાર tables (`inquiries`, `feedback`, `app_releases`, `chat_messages`) માં એ ક્યારેય
   ચાલુ નહોતી — એટલે દરેક table માં ચાલુ કરો અને API નો બાકી રહેલો access કાઢી નાખો:

   ```sql
   DO $$
   DECLARE t text;
   BEGIN
     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
     END LOOP;
   END $$;
   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;
   ```

   છેલ્લા result ની દરેક row માં `true` હોવું જોઈએ. (Nexora ની service tables ની owner છે, એટલે
   row-level security એને રોકતી નથી.) પછી આ ચલાવો:

   ```sql
   SELECT 'companies' AS t, count(*) FROM companies     UNION ALL
   SELECT 'company_users',  count(*) FROM company_users UNION ALL
   SELECT 'licences',       count(*) FROM licences      UNION ALL
   SELECT 'sync_records',   count(*) FROM sync_records;
   ```

   આંકડા એ run ના **Summary** ના rows table સાથે મળવા જોઈએ.
7. **એ જ દિવસે સાફ કરો:** `D:\nexora-restore\nexora.dump` અને `D:\nexora-restore\restore.list`
   delete કરો (`.dump` માં દરેક company નો data ખુલ્લો છે), અને scratch project delete કરો
   (**Project Settings → General → Delete project**).

### માસિક restore test

**દર મહિનાના પહેલા કામકાજના દિવસે** સૌથી નવા backup સાથે ઉપરનાં restore પગલાં કરો. રોજ રાત્રે
GitHub પર restore થાય જ છે; માસિક test એ સાબિત કરે છે જે robot નથી કરી શકતો — કે **તમારી** પાસેનો
passphrase હજી file ખોલે છે, PC ના tools ચાલે છે, અને પગલાં યાદ છે. ઉપરના English table માં નોંધ
કરો.

### Disaster recovery (live database ખોવાઈ જાય)

1. નવો Supabase project, region **Mumbai (ap-south-1)**, મજબૂત password (password manager માં).
   અહીં Data API ચાલુ રાખો (*Only Connection String* **ન** પસંદ કરો) — `keepalive.yml` એને ping
   કરે છે. **Database → Extensions** → **pg_cron** અને **pg_net** enable કરો. પછી restore **પહેલાં**
   ઉપરના પગલા 1 ની ત્રણ `ALTER DEFAULT PRIVILEGES` lines ચલાવો.
2. સૌથી નવો backup એમાં restore કરો — ઉપરનાં પગલાં 2–6, નવા project ની Session pooler URI સાથે.
   પગલું 6 lock છે: દરેક table માં row-level security અને API roles નો કોઈ access નહીં (Nexora
   એ વાપરતું જ નથી). એ છોડશો નહીં.
3. બે scheduled jobs ફરી બનાવો (SQL Editor). Schedules live છે, 2026-10-01 એ `cron.job` માંથી
   વાંચેલા; pg_cron UTC માં ચાલે છે, એટલે `3-12` = 08:30–18:29 IST:

   ```sql
   SELECT cron.schedule('nexora-keepalive',   '17 */6 * * *',    'SELECT ops.beat()');
   SELECT cron.schedule('nexora-wake-render', '*/10 3-12 * * *', 'SELECT ops.wake_render()');
   ```

4. Render → **nexora-api** → **Environment** → `DATABASE_URL` નવા project ની pooler string કરો →
   save. `https://nexora-api-55jv.onrender.com/health` ચકાસો.
5. આ repository માં `SUPABASE_DB_URL` secret, અને `.github/workflows/keepalive.yml` માં Supabase
   address અને anon key બદલો.

Desktop અને phone apps ફક્ત Render સાથે વાત કરે છે, એટલે ગ્રાહકોના મશીન પર કંઈ બદલવું પડતું
નથી. Backup ના સમય પછી લખાયેલું (વધુમાં વધુ લગભગ એક દિવસ) એમાં નથી.
