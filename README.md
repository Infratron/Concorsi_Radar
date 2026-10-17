# Concorsi Radar

Bot Telegram che scandaglia le fonti italiane di **concorsi a premi** e ti avvisa
*solo* di quello che conta: due digest al giorno più un avviso immediato per i
concorsi di alto valore o in scadenza. Gira su Cloudflare Workers (piano
gratuito) con database D1. Costo: **€0**.

Ideato per l'uso in due (tu + una persona di fiducia, o più): ognuno ha le
proprie preferenze, i propri pesi appresi dai bottoni e le proprie consegne,
ma le fonti e i concorsi sono condivisi.

---

## 1. Come funziona

```
GitHub Actions ogni 30 min ──► raccolta (stessa pipeline, nessun limite di CPU)
                         ├─ fetch con ETag/Last-Modified e retry
                         ├─ parsing RSS/Atom, sitemap, Google News, liste HTML
                         ├─ deduplica: stesso concorso da più aggregatori → un solo item
                         ├─ arricchimento: scadenza, premio, come partecipare, sforzo
                         │   (regole deterministiche; Workers AI solo sui casi dubbi)
                         └─ punteggio 0-100 + pesi appresi dai tuoi bottoni
                                   │
                                   ▼  D1 (via API HTTP di Cloudflare)
Cron Worker */15 ──► item sopra soglia ──► avviso immediato ✅ 🚫 🏆
                      archivio dei concorsi scaduti
                      e, se la raccolta su Actions tace da 2 ore,
                      raccolta di riserva (solo le fonti raggiungibili)
Cron 06:05 e 17:05 UTC ──► digest ──► Telegram
Telegram ──webhook──► comandi e feedback
```

Decisioni di progetto che contano:

- **La deduplica è il cuore.** Lo stesso concorso compare su 4-5 aggregatori con
  titoli diversi: senza deduplica il bot diventa esattamente lo spam che non
  vuoi. Vedi la sezione 6.
- **La raccolta gira fuori da Cloudflare.** Non è una preferenza: dalla rete di
  Workers diverse fonti italiane rispondono 403 o 503, mentre le stesse richieste,
  con la stessa User-Agent, da un runner GitHub ricevono 200 (misurato il
  16/10/2026: 6 fonti su 8 bloccate). La pipeline è la stessa
  ([src/pipeline.ts](src/pipeline.ts)); cambia solo il trasporto del database,
  che da binding D1 diventa l'API HTTP di D1 ([src/db/d1-http.ts](src/db/d1-http.ts)).
- **Fuori da Workers non c'è il budget di CPU**, quindi la raccolta legge tutte le
  fonti abilitate a ogni giro (`allSources`). La rotazione a slot resta nella
  pipeline ed è quella che userebbe un tick dentro il Worker, ma con una cadenza
  fissa di 30 minuti cadrebbe sempre nello stesso slot e metà fonti non verrebbe
  mai letta: da qui la modalità completa. Numeri e metodi nella sezione 9.
- **Il radar non si spegne se GitHub si ferma.** Ogni tick da 15 minuti il Worker
  guarda se la raccolta su Actions ha girato di recente: se non lo fa da più di
  due ore (secret scaduto, workflow disattivato dopo 60 giorni di inattività del
  repository, GitHub in tilt) ricomincia a raccogliere da sé, con la rotazione e il
  freno di CPU di prima. Raggiunge poche fonti — è la rete di Cloudflare a essere
  bloccata — ma sono più di zero, e la nota in `/health` dice che è scattata
  (`raccolta di riserva: …`). Quando Actions gira, il Worker non scarica nulla.
- **In chat si tocca, non si scrive.** Il bot è un menù a pulsanti e tiene **un
  solo messaggio** per chat: aprirlo, cambiare sezione o pagina, tornare indietro
  sono modifiche di quel messaggio, e il comando che hai scritto viene cancellato.
  I comandi *scritti* (`/start` compreso) fanno eccezione a metà: tolgono il
  messaggio precedente e ne mandano uno nuovo, perché un comando può arrivare
  quando quello vecchio non è più visibile (vedi la sezione 5).
  Vedi la sezione 5; il perché tecnico sta in
  [src/telegram/screens.ts](src/telegram/screens.ts) e
  [src/telegram/bot.ts](src/telegram/bot.ts).
- **Solo concorsi ancora attivi.** Ogni item passa un cancello prima di entrare
  in archivio ([src/enrich/freshness.ts](src/enrich/freshness.ts)): fuori le
  pagine di un'edizione passata, quelle che dicono "vincitori" o "concluso", le
  pagine ferme da più di sei mesi e — dalle fonti di elenco, dove il titolo è lo
  slug — le pagine di catalogo, le tassonomie e le pagine indice. Le **offerte**
  invecchiano prima: un coupon non dichiara quasi mai una scadenza, quindi lì
  conta la data di pubblicazione, e dopo 60 giorni è fuori — sia all'ingresso sia
  nella pulizia (`expireOldItems`, che tiene la stessa regola). Le stesse
  regole valgono per il digest e per la pulizia dell'archivio (`npm run prune`),
  e la nota di ogni raccolta dice quanti item ha scartato e perché.
  Due falsi positivi misurati il 16/10/2026 e corretti: un anno citato vale come
  edizione chiusa solo se è plausibile ("Philips Airfryer **Serie 2000**" non è
  un'edizione del 2000) e la parola "vincitore" da sola non chiude niente —
  "incontra il vincitore di X Factor" è il premio, non la fine della gara.
- **Tre tipi, tre sezioni: concorso, offerta, articolo.**
  Ogni item entra in archivio con un tipo (`contest`, `coupon` o `news`) deciso in
  [src/enrich/kind.ts](src/enrich/kind.ts) da URL, titolo e tipo di fonte: la
  sezione dei concorsi contiene **solo pagine su cui si partecipa**, mentre la
  notizia *sul* concorso, la pagina-elenco e la tassonomia finiscono in 📰 News.
  È la differenza fra aprire un link e partecipare, e aprire un pezzo che
  promette dieci concorsi e non ne fa vincere nessuno. Gli articoli non
  producono notifiche: si leggono quando si vuole. Misurato il 16/10/2026 su una
  lettura delle sole fonti di cronaca: **30 articoli e 10 concorsi** — senza la
  divisione, quei 30 finivano nella sezione dei concorsi. La riga è sottile, e la
  prova dal vivo del 16/10/2026 su Scontrino Felice l'ha mostrata: le sue pagine
  `/premio-certo/premio-certo-<marca>` ripetono il nome della cartella (una
  pagina, non una categoria) e "scopri tutti i premi" è il premio di una
  raccolta punti, non il titolo di una rassegna — **24 promo vere su 24
  finivano in News**, ora zero.
- **In News ci va solo roba che riguarda un concorso o un'offerta.** Il filtro
  di pertinenza (`looksLikeNewsContest` in [src/enrich/rules.ts](src/enrich/rules.ts))
  non si accontenta di "in palio": il 17/10/2026 la sezione era piena di
  estrazioni del SuperEnalotto e dell'Eurojackpot, gare sportive ("in palio i
  titoli regionali"), premi professionali (candidature, borse di studio) e
  perfino il titolo di un episodio TV. Il gioco d'azzardo e i risultati
  ("ha vinto", "numeri vincenti") restano fuori sempre; lo sport solo se
  l'articolo non parla anche di un premio da consumatore — "Concorso Barilla: in
  palio biglietti per la partita" è un concorso vero. Stessa giornata, stessa
  causa: una promozione con le date nel nome (`dal-15-ottobre-al-1-novembre-2026-…`)
  veniva scambiata per una categoria e finiva in News, e l'anno scritto in fondo
  all'intervallo non veniva letto, così promo chiuse nel 2024 entravano con la
  scadenza dell'anno dopo. I 48 articoli dell'archivio sono stati ripuliti: 20
  sono rimasti, 22 archiviati perché fuori tema, 6 righe AIA sono tornate
  concorsi (tre delle quali chiuse).
- **Le offerte hanno una sezione loro, e una vita più corta.** Un buono sconto
  non si vince, si spende: le due cose si cercano in momenti diversi, quindi
  💶 Coupon e rimborsi è una sezione a sé (sette fonti dichiarano la categoria
  `coupon` in [src/config/sources.ts](src/config/sources.ts), cinque accese) e le offerte **non
  producono notifiche** — avvisi e digest guardano i soli concorsi, perché un
  coupon da stampare non è mai urgente come una scadenza. La promozione che
  **annuncia anche un premio** resta invece un concorso, e lo fa in modo
  dichiarato: "Cashback Fabuloso: 5 € di rimborso **e vinci** una lavatrice" sta
  fra i concorsi, perché nasconderlo costerebbe più di un coupon di troppo (la
  regola sta in [src/enrich/kind.ts](src/enrich/kind.ts)).
- **Le due metà dell'archivio hanno una sezione ciascuna.** "Quali posso fare
  senza comprare?" e "quali chiedono di comprare?" sono due domande secche che
  prima si ottenevano solo accendendo il filtro **🎁 solo senza acquisto** in
  🎛 Cosa vedi e ricordandosi di spegnerlo: `🆓 Gratis` e `💸 Con acquisto` sono
  due sezioni (e `/gratis` e `/spesa` due comandi). Il vincolo è sulla colonna
  `requires_purchase` (chi dichiara "senza obbligo di acquisto" vince sul resto
  del testo, chi non dichiara niente resta in elenco), non sui tag; il numero sul
  bottone nasce dalla stessa query dell'elenco, e i filtri della chat valgono
  anche qui (qui sotto).
- **Premio certo e omaggio con acquisto sono due porte, non due parole.** "Il
  premio me lo danno di sicuro?" e "che cosa ricevo comprando?" sono domande
  diverse, e da oggi hanno un tag, una porta in 🎁 Tipi di premio e una
  scorciatoia (`/premio-certo`, `/omaggi`). Il primo è un tag che leggono le
  regole ("premio certo", "premio garantito"); il secondo è **derivato** dalla
  spesa più il regalo scritto nel testo, e non è mai un'estrazione né un
  rimborso. Prima di aprirle le ho misurate: i numeri e il perché stanno nella
  sezione dei tipi di premio.
- **Il bando si cerca dove c'è, e si salva sulla riga.** Il bottone 📄 Regolamento
  della scheda non dipende più dal fatto che il riassunto del feed nomini il
  bando: la raccolta legge la pagina del concorso, sceglie il link che somiglia al
  regolamento (il nome conta più dell'URL, l'origine uguale spareggia, il PDF vale
  un punto in più) e lo salva su `items.rules_url`. Le regole di questa ricerca
  sono in [src/enrich/regulation.ts](src/enrich/regulation.ts) e i numeri veri —
  **73 bandi su 83 concorsi nuovi** e zero link sbagliati — sono nella sezione 5.
- **Google News è la fonte più fresca** (batte gli aggregatori di ore), ma porta
  anche rumore: le sue notizie passano un filtro di pertinenza prima di entrare e
  restano comunque in 📰 News, perché il link è la pagina del giornale.
- **Al primo giro in assoluto nessun avviso immediato**: si riempirebbe
  l'archivio di concorsi vecchi. Ci pensa il digest.

## 2. Requisiti

- Node 22.13+ e npm (il progetto è testato su Node 24, fissato in
  [.node-version](.node-version)): da 22.6 Node esegue direttamente i file
  TypeScript, da 22.13 `node:sqlite` non richiede più un flag — e i test lo usano
  per eseguire l'SQL vero su un database in memoria
- Un account Cloudflare (gratuito)
- Un bot creato con [@BotFather](https://t.me/BotFather)
- Un account GitHub con il repository del progetto (privato va benissimo): serve
  sia al deploy continuo sia alla raccolta, che gira su Actions

## 3. Configurazione dell'ambiente

I segreti **non stanno nel repository**. Ci sono due strade:

| Dove | File/comando | A cosa serve |
|---|---|---|
| Sviluppo locale | `.dev.vars` (ignorato da git) | letto da `wrangler dev` |
| Produzione | `npx wrangler secret put NOME` | valori cifrati su Cloudflare |

Il template con le spiegazioni è [.dev.vars.example](.dev.vars.example): copialo
in `.dev.vars` e riempi i quattro valori.

| Variabile | Significato |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token di @BotFather |
| `WEBHOOK_SECRET` | segreto condiviso col webhook; generalo con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_CHAT_ID` | **tuo** chat id: riceve anche gli avvisi tecnici (fonte in errore) |
| `ALLOWED_CHAT_IDS` | chat autorizzate a usare il bot, separate da virgola: `111111111,222222222` |

> Nota: `.env` non serve. Workers non legge file `.env`: i valori arrivano dai
> binding dell'ambiente, che in locale sono `.dev.vars` e in produzione i secret.

**Non conosci il tuo chat id?** Scrivi qualsiasi cosa al bot: se non sei ancora
autorizzato risponde con il tuo id (e non fa nient'altro). Aggiungilo a
`ALLOWED_CHAT_IDS`, ridistribuisci e riscrivi `/start`.

**Formato di `ALLOWED_CHAT_IDS` (errore facile):** è **una sola** variabile che
contiene tutti gli id sulla stessa riga, separati da virgola:

```
ALLOWED_CHAT_IDS = 111111111,222222222
```

Crearne due separate (`ALLOWED_CHAT_IDS_1`, `ALLOWED_CHAT_IDS_2`) **non funziona**:
il codice legge solo `ALLOWED_CHAT_IDS`. Se `ADMIN_CHAT_ID` non è impostato, il
primo id dell'elenco fa anche da admin (riceve gli avvisi tecnici).

**Come verificare cosa ha davvero il Worker**: `GET /status` elenca in `missing`
le variabili assenti, quindi è il controllo più rapido dopo averle inserite. Nel
dashboard ricordati di premere **Save**: finché resta il banner *Unsaved changes*
le variabili non esistono per il Worker, e anche una volta salvate servono alcuni
secondi per vederle attive.

```bash
curl "https://concorsi-radar.<tuo>.workers.dev/status"
# {"ok":true,"bot":"Concorsi Radar","missing":[]}   ← niente da aggiungere
```

## 4. Installazione e primo deploy

```bash
npm install
npx wrangler login                # una volta sola: apre il browser su Cloudflare

# 1. database
npm run db:create                 # copia il database_id restituito in wrangler.toml
npm run db:sync                   # tabelle, colonne e fonti in un comando solo
                                  # (idempotente: si riesegue a ogni aggiornamento)
# npm run db:init e npm run db:seed restano, e fanno le due metà dello stesso
# lavoro — ma db:sync è quello che gira da solo (sezione «Deploy continuo»)

# 2. segreti (uno alla volta, incolla il valore quando richiesto)
npm run secrets:token
npm run secrets:webhook
npm run secrets:admin
npm run secrets:chats

# 3. pubblica
npm run deploy                    # stampa l'URL del Worker, es. https://concorsi-radar.<tuo>.workers.dev

# 4. registra webhook e menu comandi (usa lo stesso WEBHOOK_SECRET)
curl "https://concorsi-radar.<tuo>.workers.dev/setup?secret=IL_TUO_WEBHOOK_SECRET"
```

Poi la raccolta: i tre secret su GitHub, come spiegato in
[«Raccolta su GitHub Actions»](#raccolta-su-github-actions). Finché non ci sono,
il Worker resta senza feed nuovi (gli avvisi e i digest funzionano, ma trovano
l'archivio fermo).

Nota sull'ordine: i segreti si aggiungono a un Worker che esiste già. Se non hai
mai pubblicato, fai prima `npm run deploy` (o la prima build, se usi il deploy
continuo) e poi i quattro `secrets:*`. Finché i segreti mancano, `/status`
risponde elencandoli in `missing`: è il modo normale di accorgersene.

Poi, **da entrambi gli account Telegram**, aprite il bot e premete `/start`:
è quello che vi iscrive alle notifiche (il bot non può scrivere per primo a
chi non ha mai avviato la conversazione) e vi mostra il menù. Da lì si va a
pulsanti: provate 📡 Fonti per vedere chi risponde e ⚙️ Impostazioni per soglia
e orari (sezione 5).

### Prova in locale

```bash
npm run db:init:local
npm run db:seed:local
npm run dev:cron                  # wrangler dev --local --test-scheduled
curl "http://127.0.0.1:8787/status"                                   # variabili mancanti
curl "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"            # tick di avvisi e pulizia
curl "http://127.0.0.1:8787/health?secret=IL_TUO_WEBHOOK_SECRET"
```

Gli script di sviluppo passano `--local` di proposito: da wrangler 4 i binding
che non si possono simulare (Workers AI) verrebbero aperti in modalità *remote* e
senza credenziali il server non partirebbe. In locale l'arricchimento AI resta
spento — fanno tutto le regole — e si accende sul deploy, dove `env.AI` esiste.

`npm run dry-run` è la prova generale **senza inviare nulla**: scarica le fonti
vere e stampa i messaggi esatti che il bot manderebbe.

```bash
npm run dry-run -- --fonti 8
```

### Raccolta su GitHub Actions

La raccolta dei feed gira su GitHub ([.github/workflows/ingest.yml](.github/workflows/ingest.yml)),
ogni 30 minuti, con `scripts/ingest.ts`: stessa pipeline del Worker, ma il
database è raggiunto via API HTTP di D1. Servono tre *repository secret*
(Settings → Secrets and variables → Actions → New repository secret):

| Secret | Dove prenderlo |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | dashboard Cloudflare → **Workers & Pages** → **Account details** → colonna **Account ID** (è anche il primo pezzo dell'URL, `dash.cloudflare.com/<ACCOUNT_ID>/...`) |
| `CLOUDFLARE_API_TOKEN` | dashboard → **Account API tokens** (`dash.cloudflare.com/<ACCOUNT_ID>/api-tokens`) → **Create Token** → **Create custom token** → permesso **Account · D1 · Edit**, risorse limitate al tuo account. Va bene anche la pagina storica `/profile/api-tokens`. Il token si vede **una volta sola**: copialo lì per lì |
| `D1_DATABASE_ID` | lo stesso `database_id` che sta in `wrangler.toml` (o **D1 SQL database** → il database: è lo UUID nell'URL) |

Il permesso deve essere **Edit**, non Read: la raccolta scrive (e con Read il job
fallisce con un 403). Non serve nessun permesso di zona o di dominio.

Facoltativi, per l'**avviso di fonte in errore** in chat (senza, tutto resta
visibile in 📡 Fonti e in `/health`): `TELEGRAM_BOT_TOKEN` e `ADMIN_CHAT_ID`.
Il racconto di ogni raccolta — chi ha risposto e chi no, con l'ora e il codice
HTTP — **non passa da Telegram**: si salva come log dell'esecuzione e si legge in
🧾 **Log delle raccolte** (sezione 5), dove non fa rumore. Ecco perché con questi
due secret mancanti non si perde niente di quello che si vedeva prima: i log si
scrivono comunque, e li legge il bot.

### La sveglia: se GitHub tace, il Worker gli chiede di partire

Il cron di GitHub non è un orologio. I workflow programmati arrivano in ritardo di
qualche minuto e, quando va male, saltano per ore — è quello che è successo il 17
di ottobre, con l'ultima raccolta ferma alle 03:21 e il radar che consegnava solo
quello che aveva già. Il Worker però scatta ogni quindici minuti e legge la
tabella `runs`: se la raccolta esterna è silenziosa da più di **45 minuti**, manda
un `workflow_dispatch` al workflow della raccolta ([src/collect/dispatch.ts](src/collect/dispatch.ts))
e la fa partire lui.

Tre freni, perché una sveglia che suona sempre è peggio di nessuna: si suona solo
oltre i 45 minuti di silenzio, non più di una volta ogni **20 minuti**, e senza
token configurato non succede niente e non si scrive niente (un "sveglia non
inviata" ogni quarto d'ora sarebbe rumore). La sveglia non sostituisce la
raccolta: fa partire quella vera, dalla rete che le fonti lasciano passare. La
raccolta di riserva del Worker resta per il guasto diverso — sveglia compresa che
non funziona (token scaduto, workflow disattivato).

Serve un **token fine-grained** di GitHub con permesso *Actions: Read and write*
solo su questo repository, messo come secret del Worker (mai in un file):

```bash
npx wrangler secret put GITHUB_DISPATCH_TOKEN   # incolla il token quando lo chiede
```

Il repository e il workflow stanno in `[vars]` di `wrangler.toml`
(`GITHUB_REPO`, `GITHUB_WORKFLOW`, `GITHUB_REF`).

Se questi tre secret mancano, il radar non resta muto: il Worker se ne accorge e
passa alla **raccolta di riserva**, e dopo **tre ore** senza una raccolta su
GitHub arriva un **promemoria in chat all'admin** (`⚠️ Raccolta ferma da N ore`,
con da quanto tace GitHub e quante fonti sta coprendo il Worker). Il promemoria
si ripete al massimo ogni sei ore — un guasto lungo non deve suonare ogni quarto
d'ora — e rispetta la fascia di silenzio: se è notte, parte al primo tick dopo.

Con la [gh CLI](https://cli.github.com) si impostano dalla cartella del progetto
(dalla UI è identico):

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID     # incolla il valore quando lo chiede
gh secret set CLOUDFLARE_API_TOKEN
gh secret set D1_DATABASE_ID
```

Poi Actions → **Raccolta concorsi** → *Run workflow* per il primo giro: la pagina
del job mostra il riepilogo (fonti ok, item nuovi, duplicati) e i giri successivi
partono da soli.

`npm run ingest` è lo stesso script da riga di comando, con le tre variabili
esportate a mano: utile per provarlo prima di affidarlo ad Actions. Da un PC che
ha già fatto `npx wrangler login` funziona anche **senza dichiarare nessun
segreto** — se le variabili non ci sono, usano il login di wrangler: token dal suo
file di configurazione, id del database da `wrangler.toml` (non è un segreto, è
nel repository) e id dell'account chiesto all'API
([scripts/wrangler-auth.ts](scripts/wrangler-auth.ts)). Quella comodità vale per
un giro a mano: il token di wrangler scade in poche ore e lo rinnova wrangler
quando lo usa, mentre un token API non scade. E il posto della raccolta
periodica resta **GitHub**: dal runner le fonti che rispondono 403 alla rete di
Cloudflare rispondono 200, e il PC di chi sviluppa non fa parte
dell'installazione. Un giro lanciato da un PC si registra come `local` invece che
`actions`, e in 🕒 Ultime raccolte si legge "questo PC": per il Worker i due
esecutori contano allo stesso modo — quello che decide se la raccolta è viva è
che giri, non da dove.

Se il job diventa rosso, i log dicono quale fonte o quale credenziale non va:
`Variabili d'ambiente mancanti: …` è un secret assente (o scritto con un nome
diverso), `D1 API 401` è il token sbagliato o incollato con uno spazio in fondo,
`D1 API 403` è il permesso `Read` invece di `Edit`, `D1 API 404` è il
`D1_DATABASE_ID` sbagliato. Un giro in cui **nessuna** fonte risponde fa fallire
il job di proposito: è la spia di un problema vero (token scaduto, permesso D1
sbagliato, rete).

> Minuti Actions: il piano gratuito ne include 2.000 al mese per i repository
> privati. Un giro dura ~1 minuto e ne partono 1.440 al mese, quindi ci si sta
> dentro con margine (e su un repository pubblico i minuti non si contano).

### Deploy continuo da GitHub (ogni push = bot aggiornato)

Il primo deploy si fa una volta a mano, come sopra. Da lì in poi conviene
collegare il repository a Cloudflare: ogni push su `main` pubblica la nuova
versione, senza `npm run deploy` e senza toccare segreti o database.

La repository è già pronta per questo: `.gitignore` esclude `.dev.vars` (i
segreti non entrano in git) e `.wrangler/` (il database locale di prova).

```bash
# 1. crea su GitHub un repository PRIVATO e vuoto (niente README né .gitignore: ci sono già)
# 2. collega e spingi
cd "<cartella del progetto>"
git remote add origin git@github.com:<utente>/<repo>.git
git push -u origin main
```

Poi nel dashboard Cloudflare: **Workers & Pages → concorsi-radar → Settings →
Builds → Connect** (è il percorso giusto perché il Worker esiste già dal primo
deploy; per un Worker che non esiste ancora è **Create application → GitHub**),
scegli il repository e imposta:

| Impostazione | Valore |
|---|---|
| Production branch | `main` |
| Root directory | *(vuota: il progetto è nella radice)* |
| Build command | `npm ci && npm run check` |
| Deploy command | `npx wrangler deploy` |
| Preview builds | **disattivate** (vedi sotto) |

Il *build command* è la rete di sicurezza: se il typecheck o l'intera suite
fallisce, la build si ferma e **il deploy non parte**. `npm ci` serve a rendere
l'installazione riproducibile dal `package-lock.json`, e `npm run check` è
`npm run typecheck && npm test` (pochi secondi).

Se in build i worker di vitest vanno in timeout sul *transform* (`Timeout calling
"fetch"` — succede su macchine molto cariche, mai sul codice), si aggiunge
`--no-file-parallelism`: la suite è la stessa e passa, solo più lenta (2-5 minuti
contro ~30 secondi). Il default resta il parallelo perché una build da venti
minuti a ogni push non è un cancello: è un motivo per non pubblicare.

**Il deploy automatico è già attivo su questo repository**: ogni push su `main`
produce una versione nuova ~1 minuto dopo (misurato il 17/10/2026: commit
`9591e40` alle 06:37:21, versione `5b4ca1bd` alle 06:38:13; commit `7da5e9d` alle
07:00:18, versione `f0d3272e` alle 07:01:17). `npm run deploy` da qui è solo un
modo per pubblicare *senza* passare da git, e non serve più.

**Versione di Node della build**: i test eseguono l'SQL vero su `node:sqlite`, che
senza flag esiste da Node **22.13**. La versione è fissata in
[.node-version](.node-version) (24, la stessa dello workflow di raccolta); se la
build di Cloudflare usasse una versione più vecchia, imposta `NODE_VERSION=24`
tra le variabili di build. Il codice del Worker, invece, gira su workerd e non
dipende da Node.

Cosa **non** cambia a ogni deploy: i segreti (un deploy non li cancella), il
database D1 e i suoi dati, il webhook Telegram già registrato. Non serve
rieseguire `/setup` né `/start`. Serve invece che `wrangler.toml` abbia il
`database_id` vero: con il segnaposto la build fallisce.

Cosa **non** fa il deploy: le modifiche allo schema del database. Da qui in poi
non serve farlo a mano — se ne occupa il workflow `Database` (sotto).

**Il passo che resta a te, e perché.** La connessione al repository nasce solo
dalla dashboard: Cloudflare deve installare la sua GitHub App sull'account e
ricevere l'autorizzazione al repository, e quella è una decisione dell'utente,
non una chiamata API. Una volta autorizzata, il resto lo si può anche pilotare
da fuori ([Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)),
ma serve un token **utente** con permesso *Workers Builds Configuration: Edit*:
la CLI di wrangler non ha un comando per questa connessione, e il login OAuth di
wrangler la Builds API lo rifiuta (403, verificato il 17/10/2026).

### Il database si allinea da solo

`.github/workflows/db.yml` esegue **`npm run db:sync`** a ogni push su `main` che
tocca lo schema o la configurazione delle fonti, e a mano quando vuoi
(`workflow_dispatch`). `npm run db:sync` è idempotente in tutte e tre le sue parti:

| Cosa | Come | Se è già a posto |
|---|---|---|
| Tabelle e indici | le istruzioni di `src/db/schema.sql` (`CREATE ... IF NOT EXISTS`) | non fa niente |
| Colonne | `ALTER TABLE ... ADD COLUMN` solo per quelle che `pragma_table_info` dice mancanti | non fa niente |
| Fonti | una UPSERT per fonte, dai file di configurazione | aggiorna la definizione, **non** lo stato runtime |

L'ordine conta ed è: **tabelle → colonne → indici**. Su un archivio vecchio gli
indici citano colonne che ancora non esistono (`items (kind, first_seen_at)`),
quindi crearli per primi fallirebbe con *no such column*.

Le colonne che il codice si aspetta stanno in un elenco in
[src/db/upgrade.ts](src/db/upgrade.ts) (`COLONNE_ATTESE`): aggiungerne una lì è
l'unica cosa da fare quando una migrazione è solo un `ADD COLUMN`, e da quel
momento non va più eseguita a mano né ricordata prima del deploy. Quello che il
comando **non** fa: rinominare, cambiare tipo, cancellare — una migrazione
distruttiva resta una decisione da prendere con il database davanti.

Sul database di produzione il comando è stato eseguito il 17/10/2026: 20
istruzioni di schema, nessuna colonna mancante, nessun indice mancante, 34 fonti
sincronizzate con `etag` e `last_ok_at` intatti.

**Se un deploy va storto**: dashboard → Worker → **Deployments** → scegli la
versione precedente → Rollback (istantaneo, non ricompila nulla); da riga di
comando `npx wrangler rollback`.

**Lavoro in due**: ogni push su `main` va subito in produzione, quindi per le
modifiche delicate usate un ramo e una pull request, e solo il merge pubblica.
Se attiverete i *Preview builds*, ogni ramo ottiene un URL di prova: ricordate
che i Preview **non** ereditano i segreti di produzione e, con lo stesso
`database_id`, condividono lo stesso database (per isolarli serve un secondo
database D1).

## 5. Come si usa: bottoni, non comandi

Il bot è un **menù a pulsanti**: si tocca, non si scrive. La differenza visibile è
che in chat resta **un solo messaggio**: aprire una sezione, una scheda o una
pagina *modifica* quel messaggio invece di mandarne un altro, e il messaggio che
hai scritto tu viene cancellato subito. Non ci sono catene di messaggi da
scorrere.

I **comandi scritti** (`/start`, `/oggi`, …) sono l'unica eccezione, e per un
motivo preciso: un comando può arrivare quando il messaggio precedente non è più
visibile — tipicamente dopo aver svuotato la chat con *Elimina conversazione*.
In quel caso Telegram accetta la modifica di quel messaggio (risponde ok) ma non
lo mostra più: fidarsi di quell'esito lascerebbe la chat muta, con il comando
cancellato e nessun menù. Per questo un comando scritto **toglie il messaggio
vecchio e ne manda uno nuovo**. In entrambi i casi in chat resta un messaggio solo.

Lo stesso vale per un **tocco su un bottone dopo molte ore** di silenzio. Un tocco
modifica il messaggio sul posto — è visibile per definizione, lo stai toccando —
ma solo se quel messaggio è ancora quello che hai davanti: se nel frattempo hai
svuotato la chat, l'avviso di ieri sera che stai toccando punterebbe a un
messaggio che non c'è più, e la chat resterebbe muta. Per questo il bot ricorda
l'ora dell'ultima interazione (`updatedAt` nello stato della chat) e, dopo
**sei ore** di silenzio, apre un messaggio nuovo anche per un tocco
([src/telegram/bot.ts](src/telegram/bot.ts), `STALE_CHAT_MS`). Sei ore coprono la
notte e tutte e due le finestre del digest, mentre una conversazione vera continua
a usare un messaggio solo — e una chat svuotata si riprende da sola, senza
scrivere `/start`.

```
📡 Concorsi Radar

[🆕 Nuovi (3)]        [📋 Oggi (12)]
[📅 7 giorni (40)]    [⏳ Scadenze (2)]
[🎁 Tipi di premio]
[⭐ Watchlist (1)]    [📰 News (7)]
[🔍 Cerca]            [🗂 Storico]
[💶 Coupon e rimborsi (67)]
[💰 Rimborsi (2) · 12,50 €]
[🏷 Marche seguite (4)] [🎛 Cosa vedi]
[📡 Fonti]            [⚙️ Impostazioni]
[🔄 Aggiorna]         [❓ Aiuto]
```

La testata dice due cose diverse: quanti concorsi, coupon e news ci sono in
archivio, e **quando ha raccolto il bot** (`🔄 Ultima raccolta: 17/10 07:40`).
L'ora dell'ultimo tocco non c'è più: era quella a far leggere "il bot si è fermato
all'una e venticinque" quando il radar aveva raccolto mezz'ora prima.

| Sezione | Cosa mostra |
|---|---|
| 🆕 Nuovi | quello che è arrivato **dall'ultimo controllo** (il numero è sulla voce del menù) |
| 📋 Oggi / 📅 7 giorni | l'archivio recente, ordinato per punteggio. **Oggi è il giorno di calendario**: alle 01:00 contiene quello che è arrivato da mezzanotte, non la giornata di ieri (che resta in 📅 7 giorni) |
| ⏳ Scadenze | chi chiude entro 7 giorni e **non è già chiuso** |
| 🎁 Tipi di premio | otto porte — 💳 gift card, 🚗 auto e moto, ✈️ viaggi, 🛒 buoni spesa, 🎁 premi certi e 🛍️ omaggi con acquisto, più le due metà dell'archivio: 🆓 gratis (**i concorsi dove non si compra niente**: senza scontrino, senza codice sulla confezione, senza spesa minima) e 💸 con acquisto (**quelli dove una spesa serve**). Si entra, si guarda, si esce, senza accendere nessun filtro (qui sotto). Le due metà stanno **solo** qui: nel menù sarebbero le stesse sezioni da due posti |
| ⭐ Watchlist | i concorsi che hai salvato, **ordinati per scadenza** (chi chiude prima sta in cima) e con il promemoria a 3 giorni e 1 giorno dalla chiusura — a 30, 7 e 1 per raccolte punti e premi da richiedere (qui sotto) |
| 📰 News | gli articoli e le pagine-elenco che parlano di concorsi: **non** sono concorsi, e il link porta al pezzo, non alla pagina ufficiale |
| 💶 Coupon e rimborsi | i buoni sconto, i rimborsi e le operazioni a cashback da spendere al negozio o online: **non** sono concorsi e **non** producono notifiche (qui sotto) |
| 💰 Rimborsi | le richieste fatte da **questa chat**: quanto denaro è già tornato, quanto è ancora in attesa, e per quali offerte (qui sotto) |
| 🗂 Storico | cosa è successo a quello che hai visto: 🏆 vinti, ⌛ chiusi (chi ha chiuso per ultimo in cima) e 🚫 scartati, che da lì puoi riprendere. Da qui si entra in 📚 Archivio |
| 📚 Archivio | **tutto quello che il bot ha mai visto**, dal più recente: concorsi chiusi e coupon scaduti compresi, con le fette 🎁 Concorsi / 💶 Coupon / 📰 Articoli. I filtri di 🎛 Cosa vedi qui non valgono (qui sotto) |
| 🔍 Cerca | scrivi una parola: il bot cancella il tuo messaggio e mostra i risultati (concorsi e news insieme, gli articoli marcati 📰, e adesso anche il passato, marcato ⛔) |
| 🏷 Marche seguite | le marche che segui (il numero sono **le marche**, non i loro concorsi): valgono **10 punti in più**, hanno una sezione loro e un avviso quando ne esce un concorso (qui sotto). Si chiamava "Preferiti per marca", e sembrava una watchlist |
| 🎛 Cosa vedi | i tuoi filtri: quali tipi di concorso, quali categorie di fonti, quali fonti e quali marche vuoi vedere (qui sotto) |
| 📡 Fonti | quali fonti rispondono: ora, codice HTTP e item dell'ultimo tentativo, più le ultime raccolte (e le porte a 🌡 Diagnostica e — solo per l'admin — a 🧾 Log delle raccolte) |
| 🏁 Vantaggio | `/vantaggio`: di quanto arriviamo prima degli aggregatori, e quanto spesso non arriviamo affatto |
| ⚙️ Impostazioni | soglia degli avvisi, fascia di silenzio e orari dei digest, regolabili di fino, più la porta ai filtri |
| 🔄 Aggiorna | rilegge tutto e dice se è arrivato qualcosa di nuovo |
| ❓ Aiuto | la wiki nella chat: un indice di bottoni, uno per argomento, e una pagina breve per sezione (qui sotto) |

`/vantaggio` (o `/anticipo`) apre la misura del **vantaggio di tempistica**: di
quanto vediamo un concorso prima degli aggregatori. La schermata dichiara i suoi
stessi limiti — da quanti giorni esiste la misura, su quanti concorsi si può
calcolare, e quante fonti hanno fallito l'ultimo giro — perché un anticipo
misurato mentre la raccolta è ferma non è un anticipo. Sulla scheda di un
concorso la stessa misura compare per quel concorso soltanto (`🏁 Visto 6 ore
prima degli aggregatori`). Il funzionamento sta in [src/enrich/lead.ts](src/enrich/lead.ts).

Tutte le sezioni dei concorsi mostrano **solo i concorsi**: la pagina di un
aggregatore o la notizia di un giornale non compaiono mai lì dentro. Le sezioni
che *notificano* (avvisi immediati e digest) guardano la stessa fetta, quindi un
articolo non ti sveglia per niente.

Gli elenchi sono **bottone per concorso** (`⭐85 ⏳3gg · Concorso Barilla…`):
toccandone uno si apre la scheda, e da lì `⬅️ Torna all'elenco`. Il numero è il
punteggio 0-100 (premio, sforzo, urgenza, freschezza, più i tuoi feedback), ed è
il criterio con cui gli elenchi dei concorsi sono ordinati: in cima c'è quello che
vale di più adesso (📰 News fa eccezione: lì l'ordine è l'ultimo arrivato, che è
l'informazione giusta per un articolo; e sulle offerte il numero **non c'è**
affatto, `💶 · Buono sconto Novi…`: il punteggio risponde a "quanto vale la pena
guardare questo concorso adesso" e su un buono sconto sarebbe inventato).

Nella scheda ci sono le decisioni ⭐ Watchlist, 🚫 Non mi interessa, 🏆
Vinto, oltre a 🔗 Apri, 📤 Condividi e 📄 Regolamento. ⭐ è un interruttore: su un
concorso già salvato diventa `☆ Togli dalla watchlist` e lo rimette fuori
(annullando anche il punto guadagnato dai pesi). 🚫 e 🏆 invece restano segnati.

La scheda è divisa in **blocchi separati da una riga vuota**, non è un elenco
unico: in cima che cosa è e il titolo (`🎁 85/100 · ⏳ 10 gg · 🛒 serve acquisto`),
poi i fatti (`🏆 Premio · …`, `📝 Come partecipare · …`), poi gli obblighi, infine
descrizione, tag e fonte. Le etichette sono in grassetto e il valore viene dopo
un punto medio, così si scorrono le etichette in verticale invece di ricominciare
a leggere ogni riga. Un coupon non si presenta come un concorso: niente punteggio,
niente parola "premio", e la riga `ℹ️ Non è un concorso: qui non si vince niente,
si spende meno.` al posto del blocco premio; un articolo ha `📰 Articolo` e
l'avviso che il link non porta alla pagina ufficiale. La fonte si dice una volta
sola, in fondo, e l'id resta l'ultima riga.

La scheda tiene anche le due informazioni che si perdono senza accorgersene:
`🧾 Da conservare · lo scontrino originale e il codice sulla confezione` e,
quando il bando lo scrive, `🎫 Premio da richiedere entro il 31/12/2026 · 41 gg`
(oppure il conto che alcuni bandi usano al posto della data: `entro 30 giorni
dalla comunicazione della vincita`). Sono estratte dal testo dell'item quando la
scheda viene disegnata ([src/enrich/proof.ts](src/enrich/proof.ts)), quindi
valgono **subito anche per l'archivio già raccolto**: nessuna colonna nuova,
nessuna migrazione, nessun comando di riempimento. Le due righe compaiono anche
nei promemoria e negli avvisi, che usano la stessa scheda.

Quando il testo non nomina la prova ma la prova c'è per forza, la riga è
generica e vera invece di essere assente: `gli scontrini e i bollini` per una
raccolta punti, `lo scontrino o la prova d'acquisto` per un concorso con
acquisto. Nei concorsi che si dichiarano gratuiti **non compare**: lì la
"confezione" nominata è il premio ("un kit da 3 confezioni"), non qualcosa da
conservare, e un consiglio sbagliato costa più di una riga mancante. Misurato
sull'archivio del 17/10/2026: **78 dei 163 concorsi attivi** mostrano la riga —
46 con la prova d'acquisto generica, 15 con scontrini e bollini, 17 con una
prova nominata dal testo. Quando la data della richiesta non c'è, resta solo
`🎫 Premio da richiedere · la data è nel bando` per le raccolte e i premi da
richiedere: **nessuna data inventata**. Nei 163 concorsi attivi la data della
richiesta è dichiarata in uno solo (Prodeco Insyn, "la fase per richiedere il
premio certo è valida dal 1° settembre al 31 dicembre"), ed è esattamente il
caso in cui la scheda la mostra.

Sui **premi certi** la scheda sa dire anche quando si gioca: `🕐 Quando giocare ·
09:00–20:00 · un premio ogni 15 minuti · ✅ adesso si gioca`, e fuori orario
`🚫 adesso fuori orario (riapre domani alle 09:00)`. Finestra e cadenza si
leggono dal testo del bando quando la scheda viene disegnata
([src/enrich/playtime.ts](src/enrich/playtime.ts)), con lo stesso principio delle
due righe sopra: **niente colonne, niente migrazioni**, e niente numeri
inventati. Se il bando dichiara solo l'orario, la cadenza non si mostra; se non
dichiara nemmeno l'orario, **la riga non c'è**. La restrizione di giorni è
rispettata (`solo il sabato`, `dal lunedì al venerdì`) e l'ora è quella italiana.
Misurato sull'archivio del 17/10/2026: **0 dei 25 premi certi** dichiarano una
finestra oraria o una cadenza, quindi oggi la riga non compare su nessuna scheda;
comparirà quando un bando la scriverà.

**📤 Condividi** apre il foglio di condivisione del telefono (WhatsApp, un'altra
chat, qualunque app) con un messaggio già scritto: `Hey! Dai un'occhiata a questo
concorso!` e poi **solo l'URL dell'item** — la pagina del concorso, o quella che
lo menziona. Niente titolo, niente punteggio, niente nome del bot: chi riceve il
messaggio non ha il bot, e un testo pieno di etichette che non capisce sarebbe
solo rumore. La frase cambia con la riga (`…questa offerta!` per un coupon,
`…questo articolo!` per una news).

Il bottone non porta a `t.me/share/url`, che apre **solo le chat di Telegram**
(era il difetto: "condividi" ma WhatsApp non c'era). Un bot non ha un pannello
di condivisione, quindi il link apre una pagina nostra, `/share`
([src/share.ts](src/share.ts)): lì `navigator.share()` chiama il pannello di
sistema del telefono — WhatsApp, messaggi, mail, qualunque app — e dove quella
API non c'è restano quattro vie esplicite: 💬 WhatsApp, ✈️ Telegram, ✉️ Email e
📋 Copia frase e link. La pagina riceve solo `u` (il link) e `t` (la frase),
accetta **solo http/https** (uno schema `javascript:` non viene mai servito),
escape tutto quello che stampa e si porta dietro una CSP chiusa:
`default-src 'none'` più lo stile e lo script inline della pagina. L'origine
arriva dalla richiesta (`shareBase` in `BotDeps`), quindi funziona anche su un
dominio custom senza costanti da aggiornare.

### 📊 Da dove viene il voto

Il numero `🎁 83/100` da solo non dice niente su **perché** un concorso sta sotto
la soglia delle stelle (`⭐ 70+`, `⭐ 80+`) o perché è in cima. La scheda lo
spiega voce per voce, con i punti che ognuna ha aggiunto e il massimo che poteva
aggiungere ([src/enrich/score.ts](src/enrich/score.ts)):

```
📊 Come nasce il 83
🏆 Premio +29/30 · 💪 Sforzo +17/20
⏳ Scadenza +18/18 · 🕐 Freschezza +6/12
🆓 Senza acquisto +10/10
💾 Alla raccolta 83 · con i gusti di adesso 80 (il filtro usa il primo)
⭐ Soglia 80: la passa di 3 punti
```

Tre scelte che vale la pena conoscere:

- **Le voci a zero si vedono.** `🏆 Premio +0/30` spiega un voto basso meglio di
  qualsiasi frase: è la ragione per cui un concorso anonimo resta sotto i 70 e
  non ti arriva mai.
- **I numeri sommano al voto.** Le voci si arrotondano distribuendo il resto (chi
  ha la parte decimale più alta prende il punto), e i due tagli veri — tetto 100 e
  pavimento 0 — sono voci esplicite (`🚧 Tetto 100`, `🏁 Minimo 0`). Un test lo
  verifica caso per caso: una spiegazione che non torna sarebbe peggio di nessuna
  spiegazione, perché è quel numero che decide se passi il filtro.
- **Due numeri, quando servono.** Il filtro delle stelle confronta il punteggio
  SALVATO alla raccolta, che non cambia da solo; le voci sommano quello di
  ADESSO, che può essere più basso perché la freschezza cala (l'esempio qui sopra
  è un concorso entrato ieri a 83 ed è 80 oggi). La scheda dice tutti e due e
  quale dei due decide, invece di mostrarne uno e far finta che sia l'altro.

Le voci che dipendono da te — `🏷 I tuoi gusti` (i tocchi ✅/🚫, ±3 punti per tag)
— compaiono solo quando cambiano qualcosa, come `⭐ Marca seguita` (+10, la marca
che segui). Sui coupon la scheda non c'è: un buono sconto non si giudica con
"quanto vale la pena guardare questo concorso", e lì il numero non esiste proprio.

**📄 Regolamento** c'è quando il bando si trova, e si trova in due modi
([src/enrich/regulation.ts](src/enrich/regulation.ts)): dal testo dell'item —
quando il feed lo cita nel riassunto — oppure **leggendo la pagina del concorso**,
dove il bando è quasi sempre un link in fondo ("Regolamento completo", "Scarica il
bando in PDF"). Il secondo modo è quello che lo rende utile: i feed portano un
riassunto di due righe che il bando non lo nomina, quindi senza la lettura della
pagina il bottone c'era **quasi mai**. Il link trovato si salva sull'item
(`items.rules_url`), così la chat non rilegge niente, e compare anche su avvisi e
digest.

Quando il bando non si trova il bottone non c'è: **mai un link inventato** — una
pagina di privacy o l'assistenza del sito non sono il regolamento, e chi ci finisce
ha perso il viaggio. Misurato il 16/10/2026 sulle pagine vere di sette fonti: su
**83 concorsi nuovi, 73 regolamenti trovati** (le pagine lette sono 83 e i 10
rimasti non nominano il bando da nessuna parte), tutti link plausibili:
bando in PDF di Eni, Coca-Cola, Pampers, Loacker, Lindt, Parmigiano Reggiano,
Leroy Merlin, Colgate, Cupper e i `regolamento.php` dei premi certi di Scontrino
Felice. Il costo è una richiesta in più **solo per i concorsi nuovi** (mai per un
coupon o un articolo), con robots.txt rispettato e un tetto per giro: i dettagli
nella sezione 9.

Ogni elenco è **a pagine di sei**, con `⏮ Inizio` / `⬅️ Prec` / `Succ ➡️` e il
numero di pagina in mezzo: la pagina che vedi la legge il database con
LIMIT/OFFSET, quindi si sfoglia tutto l'archivio, non solo le prime righe. Da una
pagina 5 di 6 si torna al principio con un tocco, non con quattro.

### ⬅️ Indietro: il posto dove si era

Ogni schermata ha `⬅️ Indietro`, e non è un secondo `🏠 Menù`: torna alla schermata
da cui si è arrivati, **con la sua pagina**. Aprire un concorso da pagina 5 di 6 e
premere indietro riporta a pagina 5 di 6 — prima la pagina si azzerava, e con
lei il posto in cui si stava leggendo. Dentro una scheda `⬅️ Indietro` la chiude e
basta, e in 🆕 Nuovi non svuota la coda: il contatore dei nuovi riparte quando si
**esce** dalla sezione, non appena se ne apre il primo concorso.

La storia dei passi è nello stato della chat (`ui.history`, JSON di sezioni e
pagine, al massimo otto passi: [src/telegram/screens.ts](src/telegram/screens.ts)),
quindi sopravvive anche a un riavvio del Worker. Una chat ripresa da una riga
scritta prima che la colonna esistesse ha la storia vuota, e in quel caso
`⬅️ Indietro` ripiega sul genitore della schermata (una tabella esplicita, mai
il nulla).

Sotto l'elenco dei concorsi c'è **una riga sola** per le stelle — `⭐ Tutte`,
`⭐ 70+`, `⭐ 80+` — con il pallino sulla soglia attiva: serve a tenere la testa
della classifica senza aprire nessun menù, e non compare dove non ha senso (📰
News, ⭐ Watchlist, 🗂 Storico, 📚 Archivio, 🔍 Cerca). Se un elenco resta vuoto con i filtri
accesi il bot lo dice (`🎛 Hai N filtri attivi`) e mette lì il bottone per
allargare: "non c'è niente" e "hai spento tu le fonti" sono due cose diverse.

### 🎛 Cosa vedi: i filtri sono tuoi

Il bot è condiviso, il feed no: **ogni chat ha i suoi filtri**, e quello che
spegni tu non cambia niente per l'altra persona (stessa regola delle consegne e
dei pesi). I filtri stanno in `prefs.filters` in D1, una riga JSON per chat.

Dentro 🎛 **Cosa vedi** ci sono tre gruppi di interruttori — ✅ mostra, 🚫
nasconde:

- **tipi di concorso**: raccolte punti, premio certo, omaggi con acquisto, gift
  card, viaggi, elettronica, casa, food, moda, bambini (sono i tag che le regole
  assegnano leggendo premio e testo);
- **categorie di fonti**: online, punto vendita, scontrino, gift card — spegnere
una categoria spegne tutte le fonti che la dichiarano;
- **⭐ stelle minime**: `Tutte`, `70+` o `80+`. È lo stesso filtro della riga in
fondo agli elenchi, e come quello vale anche per le notifiche;
- **🎁 solo senza acquisto**, che lascia fuori chi chiede uno scontrino, un codice
sulla confezione o un minimo di spesa. È un filtro che **resta acceso** e cambia
**tutte** le sezioni filtrate, mentre 🆓 Gratis è una domanda secca con una
sezione sua: vedi la differenza qui sotto;- **📡 Scegli le fonti**: l'elenco delle fonti accese, una per riga e a pagine,
  per spegnere quella singola che ti manda rumore;
- **🔕 Marche spente**: le insegne che hai spento dalla scheda di un concorso,
  con 🔕 Mai più. È l'esclusione più fine che c'è — la fonte intera è troppo,
  il singolo concorso è troppo poco — e si riaccende da qui con un tocco.

Sono **esclusioni, non inclusioni**: una fonte o un tipo nuovi si vedono finché
non li spegni, quindi un archivio che cresce non ti resta invisibile. I filtri
valgono nelle sezioni che *suggeriscono* cosa guardare (🆕 Nuovi, 📋 Oggi, 📅 7
giorni, ⏳ Scadenze, 📰 News, ⌛ Scaduti), nei **numeri del menù** (che contano
quello che vedi, con la riga `🎛 Filtri tuoi: 12 di 40 concorsi` a dire quanto
stai lasciando fuori) e nelle **notifiche** — digest e avvisi immediati. Non
valgono invece su ⭐ Watchlist, 🗂 Storico, 📚 Archivio e 🔍 Cerca: lì hai scelto
tu cosa guardare, e un concorso salvato non deve sparire perché hai spento la sua
fonte — né un coupon che esiste deve restare invisibile perché non risponde alle
tue preferenze.

### 📚 Archivio: la memoria completa, e perché è un posto a parte

Le sezioni dei concorsi rispondono a "cosa guardo adesso", quindi un concorso
chiuso e un coupon scaduto escono dall'elenco: giusto, ma restava senza risposta
la domanda che si fa più spesso, *"questo l'avevamo già visto?"*. **📚 Archivio**
è quel posto: tutto quello che è passato dal bot, di qualunque tipo e in qualunque
stato, dal più recente, con i concorsi già chiusi segnati **⛔** perché non si
aprono credendo di poterci ancora partecipare. Il numero sulla porta e in 🗂 Storico
è l'archivio intero — non la somma di 🏆 vinti, ⌛ chiusi e 🚫 scartati, che sono
le *tue* decisioni: qui c'è anche quello che non ti è mai stato consegnato.

I filtri di 🎛 Cosa vedi non valgono qui, come in ⭐ Watchlist e 🔍 Cerca: un
coupon che non trovi più perché hai spento la sua fonte sarebbe la sorpresa
peggiore di una schermata che promette "se l'abbiamo visto, si trova". Le fette
sono `archivio:<tipo>` (`archivio:coupon`, `archivio:contest`, `archivio:news`) e
si accettano solo per i tre tipi veri: una sezione inventata non legge niente,
mentre un tipo sbagliato letto come "tutto" mostrerebbe l'archivio completo
credendo di averne chiesto una fetta. `/archivio` (o `/passati`) è la stessa cosa
scritta come comando.

Misurato il 16/10/2026 con la chat vera sopra uno store D1 su SQLite: spegnendo
le raccolte punti e la categoria scontrino, l'elenco passa da 3 a 2 concorsi, il
digest di quella chat cambia e quello dell'altra no, e `♻️ Vedi di nuovo tutto`
rimette l'archivio intero (31 controlli su 31).

### 🏷 Marche seguite: le marche che ti interessano

Si chiamava **Preferiti per marca** e il nome ingannava: sembrava la watchlist
dei concorsi messi da parte, mentre qui non si salva nessun concorso — si sceglie
**quali marche seguire**. Il numero sul bottone sono le marche (non i loro
concorsi), e la schermata dice in due righe cosa comporta seguirne una.

Ferrero, Coca-Cola, Conad: le marche che ti interessano valgono più delle altre, e
la sezione **🏷 Marche seguite** è dove si dicono. Ogni voce è un
interruttore (`✅` la segui, `⬜️` no) con **quanti concorsi ha in archivio**: le
marche che hanno qualcosa stanno in cima, quelle che non ne hanno in fondo, così
il registro si scorre a pagine di dodici senza cercare niente.

Accendere una marca fa **tre** cose:

1. i suoi concorsi valgono **10 punti in più** (e la scala è dichiarata: è più di
tutti i segnali di qualità — un premio certo vale 5 — e meno dell'urgenza di una
scadenza a tre giorni);
2. i concorsi **già in archivio** vengono ripunteggiati subito, con lo stesso
conto dell'ingestione: la marca che segui oggi non aspetta la prossima raccolta;
3. nasce la sezione **📋 I loro concorsi**, che mostra solo quello;
4. un loro concorso **avvisa subito**, anche sotto la soglia degli avvisi
   immediati: la regola scavalca solo il punteggio, gli altri freni restano (vedi
   "Le notifiche").

Il filtro vero è a parte, ed è `🌟 Solo le marche seguite: sì`: acceso, **tutti**
gli elenchi e le notifiche mostrano solo le marche che segui. È voluto che siano
due cose distinte: *seguire* Ferrero non vuol dire *non volerne sapere* delle
altre, quindi seguire una marca non nasconde niente e non conta come filtro
attivo — a nascondere è solo quell'interruttore, e lì il numero sul bottone 🎛 lo
dice.

**Come si riconosce una marca** (`src/config/brands.ts`). Due strade, e valgono
tutte e due:

- dalla **fonte**: le fonti di marca dichiarano lo slug nei loro tag, ed è
  quello giusto — la pagina di un brand non sempre nomina se stessa nell'URL
  (`/promozioni/…`);
- dal **testo** (titolo, sommario e URL) quando il concorso arriva da un
  aggregatore o da una query di news: *Concorso Nutella* è Ferrero anche senza
  nessun tag addosso.

Le parole si confrontano come token interi e senza diacritici, mai come
sottostringhe: `aia` non pesca `baia`, e le sotto-marche stanno dentro la marca
che le possiede (kinder e nutella → Ferrero). Dove la parola è anche una parola
italiana comune la marca si riconosce da un'altra prova: **AIA** non si cerca in
`aia` (l'aia della fattoria) ma in `aiafood`, che è in tutti i suoi URL. Una
marca che non si riconosce resta `null`: una riga in meno, mai una riga
sbagliata.

La marca è una **colonna di `items`** (`brand`), non un tag: si calcola
all'ingestione una volta sola, e questo è quello che rende possibile sia la
sezione (una query, non un filtro in memoria) sia il conteggio per marca sui
bottoni. Su un archivio già esistente le righe si riempiono con **`npm run brands
-- --apply`** (senza `--apply` è una prova a vuoto: elenca e basta), e il comando
serve di nuovo ogni volta che il registro impara una parola nuova — una marca
aggiunta oggi non riconosce da sola le righe raccolte ieri.

Seguire e non seguire è **per chat**, come i filtri e i pesi: quello che accendi
tu non cambia niente per l'altra persona. Una cosa sola è condivisa, ed è
dichiarata: il **bonus di punteggio** si applica alle righe d'archivio, e una
riga non è di nessuno in particolare — l'insieme delle marche seguite è l'unione
delle chat attive (`mergedBrands`, in [src/pipeline.ts](src/pipeline.ts)).

### 🔕 Mai più una marca

Seguire e **spegnere** sono due cose opposte, e prima esisteva solo la prima: per
non vedere più un'insegna si poteva spegnere la fonte intera (troppo) o ignorare
un concorso alla volta (troppo poco). Dalla scheda di un concorso, **🔕 Mai più
Ferrero** spegne la marca per questa chat: spariscono i suoi concorsi, anche
quelli già in archivio, negli elenchi come negli avvisi e nel digest — perché il
filtro passa da `filtersFor` e non da un controllo locale. Le righe **senza marca
riconosciuta restano**: non si può escludere quello che non si conosce, e
`brand NOT IN (…)` da solo le avrebbe fatte sparire (`NULL NOT IN (…)` è NULL).

Si riaccende da 🎛 **Cosa vedi → 🔕 Marche spente**: una marca spenta non compare
in nessun elenco, quindi senza quella porta resterebbe spenta per sempre. Sulle
schede della ⭐ Watchlist il bottone diventa **🔔 Rivedi Ferrero**, perché lì i
filtri non valgono e un concorso salvato non deve sparire da sotto le dita.

**⭐ Watchlist** è il posto dove tieni i concorsi che vuoi fare davvero. Due cose
la rendono utile: l'ordine per scadenza (chi chiude prima è in cima) e il
promemoria automatico **tre giorni e un giorno prima della chiusura** — un
messaggio con il link, così non si perde proprio quello che tenevi d'occhio. Chi
non ha una scadenza resta in watchlist senza promemoria. Da lì si esce sempre:
si apre il concorso e si tocca `☆ Togli dalla watchlist` — nessuna riga resta
salvata per forza, nemmeno quelle messe lì per sbaglio o da un avviso.

Se quello che hai salvato è una **raccolta punti** o un **premio da richiedere**,
il promemoria arriva molto prima: sono le due cose per cui la data di chiusura è
la data sbagliata (🧾 qui sotto).

**Watchlist** e **Non mi interessa** addestrano i pesi: ogni tag dei concorsi che
salvi guadagna un punto, quelli che ignori ne perdono uno (clamp ±5 per tag),
quindi i punteggi si spostano verso i tuoi gusti. Le decisioni sono **per
persona**: se tu ignori un concorso, alla tua amica arriva lo stesso.

**Le notifiche** (avvisi immediati, promemoria della watchlist e digest) sono
messaggi a sé, e hanno gli stessi bottoni: dal digest tocchi un concorso e si
apre la scheda nella schermata viva. Nel digest e negli elenchi ogni concorso
occupa **due righe**: `⭐85 · titolo` e sotto `🏆 premio sintetico · ⏳ scadenza`,
così premio e data si leggono senza aprire la scheda. Il conto dei giorni compare
negli ultimi sette (`⏳ 4 giorni (24/11)`), più lontano basta la data, e chi è
chiuso lo dice (`⛔ scaduto il 19/11`). Sui coupon la seconda riga è la cifra che
torna indietro; sugli articoli è il tipo.

La differenza è cosa succede dopo: il digest **resta** (è contenuto da rileggere),
mentre l'avviso immediato ha già fatto il suo lavoro appena lo usi e il bot lo
cancella, così in chat non resta niente di appeso.

**Un concorso di una marca che segui avvisa subito, anche sotto la soglia.** La
soglia risponde a "quanto vale la pena guardarlo adesso" (premio, sforzo,
scadenza); un Ferrero uscito dieci minuti fa vale la pena guardarlo comunque,
anche se il premio è piccolo e chiude fra due mesi — è quello che "seguo questa
marca" voleva dire. La regola scavalca **solo** il punteggio: fascia di silenzio,
distanza di 20 minuti fra due avvisi, età massima di 3 ore, "già consegnato" e i
filtri veri (fonti spente, tag spenti, solo gratis) valgono identici. L'avviso lo
dice in prima riga (`🏷 Ferrero · marca che segui`), così non sembra un punteggio
sbagliato. Il codice sta in [sendInstantAlerts](src/telegram/digest.ts).

Decidere due volte la stessa cosa — doppio tocco, o lo stesso concorso visto nel
digest e nella scheda — non sposta i pesi due volte.

I comandi funzionano ancora ma sono scorciatoie, non il modo normale: `/start`
(che è anche l'iscrizione, ed è l'unico pubblicato nel menù "/" di Telegram),
`/menu`, `/nuovi`, `/oggi`, `/settimana`, `/scadenze`, `/gratis`, `/spesa`,
`/premio-certo` (o `/premicerti`), `/omaggi` (o `/omaggio`),
`/salvati` (o `/watchlist`), `/news`, `/coupon` (o `/offerte`), `/rimborsi` (o `/cashback`), `/storico`, `/archivio` (o `/passati`),
`/vinti`, `/scaduti`, `/cerca`, `/fonti`,
`/diagnostica`, `/vantaggio`, `/impostazioni`, `/aiuto` (o `/help`), `/stop` e
`/salva|/vinto|/ignora <id>`.

### ❓ Aiuto: la wiki nella chat

La wiki è una sezione come le altre (una schermata sola, che si modifica), ma
invece dell'archivio mostra **una pagina breve per sezione**: cosa vedi, cosa
fare, e nient'altro. La prima schermata è un **indice di bottoni**, uno per
argomento, due per riga: si arriva a ⚙️ Impostazioni in un tocco, non in
dodici frecce. Non ci sono frecce: con quelle si poteva solo scorrere, e chi
cercava un argomento doveva ricordarsi dove fosse.

Il bottone **❓ Aiuto** non sta solo nel menù: ogni sezione che ha una pagina se
lo porta dietro, in fondo alla schermata e prima della coda di navigazione. Da
⚙️ Impostazioni o da 🎛 Cosa vedi si apre la pagina di quella sezione senza
tornare al menù — ed è la pagina che spiega *dove sei*, non quella del menù.

Le pagine stanno in [src/telegram/help.ts](src/telegram/help.ts), una voce
dell'elenco `HELP_PAGES` per pagina.

```ts
{ id: "coupon", section: "coupon", title: "💶 Coupon e rimborsi", lines: [
  "Buoni sconto, rimborsi e cashback ancora spendibili.",
  "Non sono concorsi, non si vince niente e non mandano notifiche.",
] },
```

Aggiungere una pagina = aggiungere una voce: la tastiera si costruisce
dall'elenco e `s:aiuto:<id>` è accettato solo per gli id che esistono davvero
(`isKnownSection` in [src/telegram/screens.ts](src/telegram/screens.ts)), quindi
una pagina inventata non apre il vuoto. Le regole di scrittura stanno in testa al
file: tre o quattro righe, cosa vedi prima e cosa fare dopo, niente gergo.

### 🎁 Tipi di premio: otto porte, nessun filtro acceso

"Voglio vedere le gift card" e "non voglio più vedere le raccolte punti" sono due
richieste diverse, e prima c'era un posto solo per la seconda. I filtri di 🎛 Cosa
vedi sono tutti **esclusioni**: si accendono, **restano accese** e cambiano tutte
le sezioni — chi vuole dare un'occhiata ai viaggi non vuole smettere di vedere il
resto, e soprattutto non vuole ricordarsi di spegnere. 🎁 Tipi di premio è la
porta per la prima richiesta: si entra, si guarda, si esce.

Otto bottoni, ognuno con quanti concorsi aprirebbe **adesso**, e dietro una
sezione che filtra in **inclusione** sul tag dell'item (`tags` nella query, che è
il campo nuovo in [src/types.ts](src/types.ts)) — tranne le ultime due, che
filtrano sulla colonna dell'acquisto e dividono l'archivio in due metà. Le
sezioni rispettano i filtri che hai già — ⭐ stelle minime, fonti spente, marche
seguite — e il numero sul bottone nasce dalla stessa query dell'elenco, come per
tutte le altre sezioni.

| Porta | Come filtra | In archivio il 17/10/2026 |
|---|---|---|
| 💳 Gift card | tag `giftcard` | 39 |
| 🚗 Auto e moto | tag `auto` | **2** |
| ✈️ Viaggi | tag `viaggio` | 21 |
| 🛒 Buoni spesa | tag `buoni_spesa` | 16 |
| 🎁 Premio certo | tag `premio_certo` | **25** |
| 🛍️ Omaggi con acquisto | tag `omaggio_con_acquisto` (derivato) | **30** |
| 🆓 Gratis | `requires_purchase = 0`, non un tag | 94 |
| 💸 Con acquisto | `requires_purchase = 1`, non un tag | 66 |

Quattro cose da sapere su questi numeri, perché sono misurati e non stimati:

- **🚗 Auto e moto è quasi vuota, ed è vero.** I concorsi con un'auto in palio ci
  sono (una Fiat Panda è il premio classico), ma il tag lo assegna il testo —
  "auto", "automobile", "moto" — e un bando che scrive solo "in palio una Panda"
  non lo prende. Ho provato ad allargare il riconoscimento alle marche e alle
  parole generiche: su 151 concorsi attivi si passerebbe da **2 a 4**, al prezzo
  di taggare `auto` un peluche panda. Due che ci sono davanti a quattro di cui una
  sbagliata è meglio, e il numero sul bottone lo dice subito com'è piccola;
- **🆓 Gratis non è il tag `gratis`** (che sta su 31 item e vuol dire "la pagina
  dice gratis"): è lo stesso vincolo dell'omonima sezione, cioè
  `requires_purchase = 0`, che ne conta **94**. La porta riapre quella sezione
  invece di duplicarla: due query e due testi per lo stesso elenco sono due cose
  da tenere allineate, e prima o poi se ne allinea una sola;
- **💸 Con acquisto è la gemella**: `requires_purchase = 1`, **66** concorsi, e
  insieme a 🆓 Gratis copre tutto l'archivio attivo (94 + 66 = 160). Un concorso
  può stare in più porte di premio (una gift card per un viaggio sta in due), ma
  in una sola delle due metà: l'obbligo d'acquisto o c'è o non c'è;
- **un item può stare in più porte** (una gift card per un viaggio sta in due): le
  porte non si escludono a vicenda, e non c'è nessuna priorità fra loro;
- **🎁 Premio certo e 🛍️ Omaggi con acquisto sono le due classi nuove, e sono
  quasi la stessa fonte.** Misurato il 17/10/2026 sull'archivio vero: premio
  certo 25 concorsi (24 da `scontrinofelice-premio-certo`, uno da una sua scheda
  nei gratuiti), omaggi con acquisto 30 (20 dei quali sono anche premi certi,
  più 10 raccolte punti). Le altre 30 fonti non ne pubblicano quasi nessuno: è
  il motivo per cui le porte sono due e non di più, e per cui il numero piccolo
  non è un guasto. La differenza fra le due domande è reale — 5 premi certi non
  chiedono una spesa, e 10 omaggi non dichiarano "premio certo" — ma nei dati
  di oggi si sovrappongono per due terzi.

La direzione dell'errore è quella dichiarata: nessun concorso finisce nella porta
sbagliata, ma qualcuno che dichiara il premio in modo insolito resta fuori. Chi
non vuole perdere niente guarda 📋 Oggi, dove i tag sono comunque una riga della
scheda (`🏷 giftcard · viaggio`) — non un elenco separato.

### 🧾 Raccolte punti e premi da richiedere: si ricordano prima

Per due cose la data di chiusura è la data **sbagliata**, e il promemoria
standard arriverebbe quando è ormai tardi:

- una **raccolta punti** (bollini, francobolli, punti fedeltà) si fa alla cassa,
  una spesa alla volta: a tre giorni dalla fine non c'è più niente da mettere
  via, e se gli scontrini li hai buttati per mesi la raccolta l'hai persa senza
  accorgertene;
- un **premio da richiedere** non arriva da solo: va riscattato, e nei bandi la
  richiesta ha una data sua, prima della fine del concorso — con i premi a
  numero limitato, aspettare l'ultimo giorno è il modo di restare senza.

Quindi la scala dei promemoria dipende dall'item: **30, 7 e 1 giorno** per questi,
**3 e 1** per tutti gli altri. Il messaggio non è la scheda e basta, ha una riga
in più che dice cosa c'è da fare *adesso* — "metti via scontrini e bollini", "il
premio va richiesto" — perché è l'unica informazione che la data non porta con sé.
Chi decide se un item è dell'uno o dell'altro tipo sono i suoi **tag**
(`reminderDaysFor` in [src/telegram/digest.ts](src/telegram/digest.ts)):
`raccolta_punti` lo assegna la fonte e le regole da mesi, `premio_da_richiedere`
è nuovo in [src/enrich/rules.ts](src/enrich/rules.ts) e riconosce le formule vere
dei titoli ("richiedi premi Ariete", "richiedi i premi Imetec", "premi
richiedibili entro il…").

Le due scale non si mescolano: la soglia dei tre giorni non appartiene alla scala
lunga. La scala dice **quando** avvisare, non pretende di averlo fatto per tempo:
chi salva una raccolta quando i trenta giorni sono già passati riceve comunque il
primo promemoria che gli tocca, con i giorni che mancano davvero ("chiude tra 5
giorni"), e il conto non ricomincia da capo a ogni giro — ogni soglia si annuncia
una volta sola. Restano valide tutte le regole di prima: solo item **salvati**,
fascia di silenzio rispettata, e nessun promemoria per chi non dichiara una
scadenza.

Perché la scala è anticipata e non calcolata su una data vera: la data della
richiesta **nei testi quasi mai c'è**. Misurato sull'archivio del 16/10/2026: **13
raccolte punti attive, 7 con una data, e una sola che nomina la scadenza della
richiesta**. Una colonna per quella data sarebbe stata una migrazione per una
riga su tredici — quindi il promemoria anticipa e lo dice, invece di far finta di
sapere quando scade il premio. La scheda però la data la mostra quando il testo
la dichiara (vedi sopra): è un'estrazione fatta al disegno della scheda, non una
colonna, e quindi non ha richiesto nessuna migrazione.

**Nota su un archivio già esistente**: `raccolta_punti` c'è già su tutte le
raccolte in archivio (lo dichiara la fonte in
[src/config/sources.ts](src/config/sources.ts)), quindi la scala lunga funziona
subito per loro. Il tag nuovo `premio_da_richiedere` invece si assegna
all'ingestione: le righe raccolte prima di oggi non ce l'hanno, e per quelle
resta la scala dei tre giorni (nessun comando di riempimento lo aggiunge: quello
di `npm run rules` cerca i bandi, non i tag).

### 💶 Coupon e rimborsi: si spende meno, non si vince

Un buono sconto da stampare, un rimborso con lo scontrino, un cashback che ti
riaccredita metà della spesa: sono la cosa che si cerca *quando si deve
comprare*, e in mezzo ai concorsi sarebbero rumore. La sezione è una riga sola
nel menù — `💶 Coupon e rimborsi (67)` — e dentro c'è solo questo.

**Le viste sono le stesse dei concorsi.** Sotto l'elenco (e anche quando l'elenco
è vuoto) ci sono cinque bottoni: `🗂 Tutti`, `📋 Oggi`, `📅 7 giorni`,
`⏳ In scadenza`, `↩️ Rimborsi e cashback`. Le prime tre rispondono alle stesse
domande delle omonime sezioni dei concorsi, applicate ai buoni: *quando è
arrivato* (non quando scade), con la stessa regola del giorno di calendario per
📋 Oggi. `⏳ In scadenza` è l'altra domanda — quali buoni finiscono entro 7 giorni
— e per questo chiede una data dichiarata: chi non ne ha una resta in 🗂 Tutti,
perchè "non lo so" non è una prova. `↩️ Rimborsi e cashback` tiene la fetta che
interessa di più quando si compra tanto: spendi e riprendi, rimborsi e cashback
(le offerte in cui tornano soldi, non i buoni da ritagliare). La vista attiva ha
il `•` davanti, come nelle impostazioni; i filtri di 🎛 Cosa vedi valgono in
tutte, perché sono sezioni che suggeriscono cosa guardare.

**↩️ Rimborsi e cashback è ordinata per convenienza**, non per data di arrivo:
prima chi rende di più per ogni euro speso. La soglia di spesa si legge dal
testo insieme al rimborso (`Spendi 100, ricevi 20`, `spendi 15 euro e riprendi
10`, `10€ di rimborso con 20€ di acquisti`, `spendendone 10`) e il bottone dice
le due cifre vicine: `💶 20 € su 100 € · 20%`. Chi non dichiara la spesa resta
in elenco ma va in fondo, perché non si può confrontare. Un rapporto sopra il
100% viene trattato allo stesso modo: non è un rimborso sulla spesa, è un bonus
di benvenuto o una cifra letta male — il caso misurato il 17/10/2026 è Satispay
("ti regala 35€ alla prima ricarica da 5€"), che in cima alla classifica
sarebbe stato il numero più sbagliato della schermata. Misurato lo stesso
giorno sull'archivio: **45 coupon con tag cashback, 26 con un rimborso
leggibile, 9 con una soglia di spesa, 8 confrontabili**; le prime della
classifica sono i due rimborsi al 100% (Henkel, Parodontax), poi i cashback al
67% e al 50%.

**Niente conteggi sulle viste**, ed è voluto: i numeri sul menù restano quelli
della sezione intera, e ogni vista dice quanti coupon ha nella sua intestazione
(`Coupon in scadenza · 4 coupon`). Un numero su cinque bottoni sarebbero cinque
query a ogni elenco per dire qualcosa che si legge già in cima.

Quattro differenze dalle altre sezioni, tutte volute:

- **niente punteggio sul bottone** (`💶 · Buono sconto Aia Spinacine…`): il numero
  risponde a "quanto vale la pena guardare questo concorso adesso" — premio,
  sforzo, urgenza — e su un'offerta non vuol dire niente. Un numero inventato è
  peggio di nessun numero;
- **niente notifiche**: avvisi immediati e digest guardano i soli concorsi. Un
  buono sconto resta valido per settimane, non c'è niente di urgente da
  svegliarti per dire;
- **la validità dichiarata è un filtro, non una decorazione**: quando il buono
  nomina una data di fine ("valido fino al 15 ottobre", "entro il 22/10") quella
  data finisce sulla riga, e da lì decide due cose. La prima: **esce
  dall'elenco quel giorno stesso** — la query di 💶 Coupon chiede le offerte non
  ancora scadute, e il numero sul bottone conta la stessa query, quindi elenco e
  totale non possono raccontare due cose diverse. La seconda: la pulizia
  periodica lo archivia **senza i tre giorni di grazia** che valgono per un
  concorso chiuso. La differenza è voluta — una pagina di concorso letta in
  ritardo resta consultabile nei 🏆 Vinti e in ⌛ Scaduti, un buono sconto
  scaduto no: al negozio il codice non passa. Chi non dichiara nessuna validità
  resta in elenco, perché "non lo so" non è una prova;
- **vita di sessanta giorni**: un coupon non dichiara quasi mai una scadenza, e
  che sia finito lo scopri quando al negozio il codice non passa. La regola
  quindi è la **data di pubblicazione**
  ([src/enrich/freshness.ts](src/enrich/freshness.ts)): all'ingresso un buono
  pubblicato da più di 60 giorni non entra — il primo giro di una fonte nuova
  scarica tutto il suo arretrato, e senza il cancello la sezione sarebbe nata
  piena di offerte morte — e i coupon arrivati da vivi li chiude il cron dopo 60
  giorni (`expireOldItems`): escono dall'elenco con lo stato *chiuso*, come i
  concorsi scaduti, e restano nello storico. La pulizia manuale (`npm run prune`)
  li **lascia stare** di proposito: un'offerta invecchiata non è un falso
  positivo, e quel comando serve a togliere quello che non è mai stato né un
  concorso né un'offerta.

La **promozione ibrida** è il caso limite, ed è gestito: "Cashback Fabuloso,
Ajax, Soflan: ricevi un rimborso di 5 euro **e vinci** una lavatrice Samsung" è un
rimborso *e* un'estrazione, quindi sta fra i concorsi — la metà da concorso non si
nasconde. Spegnere la categoria **💶 Coupon e rimborsi** in 🎛 Cosa vedi toglie di
mezzo la sezione intera, senza toccare le fonti.

Misurato il 16/10/2026 sui feed veri, con la pipeline vera e la schermata vera in
chat: **6 fonti su 6 rispondono, 107 item letti, 72 nuovi di cui 67 coupon**,
**31 scartati dal cancello perché vecchi** (18 + 8 + 5, tutti "offerta vecchia"),
4 duplicati e **4 concorsi nati da queste fonti** — i cashback che annunciano
anche un premio. Si apre con `/coupon` e la schermata dice `67 coupon · pagina
1/12`.

### 💰 Rimborsi: quanto è tornato e quanto manca

Un coupon si richiede e poi si aspetta. La sezione 💰 Rimborsi — il bottone
sotto 💶 Coupon e rimborsi, oppure `/rimborsi` (o `/cashback`) — tiene per chat
le richieste fatte, con due cifre separate: **recuperati** (i soldi tornati) e
**in attesa** (una promessa, non un guadagno). La richiesta si registra dalla
scheda di un coupon con `💰 Ho richiesto`; quando i soldi arrivano si tocca
`✅ L'ho ricevuto`, e `↩️ Annulla` cancella la richiesta.

L'importo lo legge il bando — prima il titolo, poi il riassunto — e distingue la
cifra esatta dal **tetto** (`rimborso di 25 €` contro `fino a 6 euro`). La spesa
richiesta non viene scambiata per il rimborso: in "10 € di rimborso con 20 € di
acquisti" il rimborso è 10 €, e la spesa di 20 € è letta a parte come soglia.
Quando il bando dichiara una **percentuale** o un
1+1 non c'è una cifra da leggere, quindi la chat chiede quanto è tornato davvero
e quel rimborso entra nel conteggio solo dopo la risposta; se resta senza cifra,
la schermata lo dice (`N senza cifra fissa`) invece di contarlo come zero. Un
tetto resta nel totale, ma lì la schermata scrive **«fino a»** e avvisa che è una
stima per eccesso: sommare un massimo come se fosse la cifra esatta è il modo più
facile di mentire sui soldi.

I totali sono un'aggregata SQL (`refundTotals`), non la somma di righe caricate:
il numero sul bottone del menù (`💰 Rimborsi (2) · 12,50 €`) nasce dalla stessa
query della schermata. Una riga per chat+offerta (`refunds`, chiave `chat_id,
item_id`): due persone possono richiedere lo stesso coupon, e un doppio tocco non
raddoppia niente. Cancellare un'offerta cancella anche la sua richiesta
(`deleteItems`), così non restano rimborsi orfani.

Limite dichiarato: il riconoscimento è per **formule** (euro, "fino a",
percentuale). Un bando che scrive l'importo in un modo mai visto resta "importo
variabile", e lo si registra scrivendo la cifra a mano.

### 🆓 Gratis: i concorsi che non costano niente

"Quali posso fare **senza comprare**?" è una delle prime domande di chi usa il
bot, e fino a oggi si rispondeva girando intorno al problema: il filtro **🎁 solo
senza acquisto** in 🎛 Cosa vedi lascia fuori chi chiede uno scontrino, ma è un
filtro che **resta acceso** e cambia **tutte** le sezioni — chi voleva solo dare
un'occhiata ai gratis doveva accenderlo, guardare, e spegnerlo. Adesso c'è una
sezione, `🆓 Gratis (94)`, e il comando `/gratis`.

Il numero sul bottone non è un conteggio a parte: nasce dalla **stessa query**
della sezione (`kinds: ["contest"], statuses: ["new", "sent"],
withoutPurchase: true`, ordinata per punteggio), quindi elenco e totale non
possono raccontare due cose diverse. Il vincolo è sull'**archivio**, cioè sulla
colonna `requires_purchase`, non sui tag: il tag `gratis` lo assegna
l'arricchimento leggendo le parole della pagina, e un concorso senza acquisto che
non scrive "gratis" da nessuna parte è identico a tutti gli altri.

Da dove viene `requires_purchase` ([src/enrich/rules.ts](src/enrich/rules.ts)):
l'arricchimento cerca il segnale d'acquisto — "acquist", "scontrin", "raccolta
punti", "minimo di spesa", "codice sulla confezione" — e **vince la negazione**:
basta che la pagina dica "senza obbligo di acquisto" e il concorso resta gratis,
anche se il resto del testo parla di scontrini. La direzione dell'errore è
voluta: chi non dichiara niente **resta in elenco** ("non lo so" non è una prova,
e il default della colonna è 0). Una riga in più da scartare costa meno di un
concorso gratis che sparisce perché nessuno l'ha scritto.

Tre differenze dal filtro 🎁:

- **non tocca le preferenze**: aprire 🆓 Gratis non accende niente in 🎛 Cosa
  vedi, e chiudendola si torna esattamente a com'era. Il filtro resta la scelta
  stabile di chi *non vuole mai* vedere i concorsi a scontrino;
- **i filtri della chat valgono anche qui**, come in tutte le sezioni che
  suggeriscono: con le ⭐ stelle minime alte o una marca muta l'elenco si
  accorcia, e il numero sul bottone si accorcia con lui;
- **sono concorsi**: i coupon "senza acquisto" e gli articoli che parlano di
  concorsi gratis non entrano — in 🆓 Gratis c'è solo roba su cui si partecipa, e
  il punteggio è quello delle altre sezioni (a differenza di 💶 Coupon, qui
  "quanto vale la pena" vuol dire qualcosa).

Misurato il 17/10/2026 sull'archivio vero: **160 concorsi attivi, 94 senza
acquisto** — quasi sei su dieci, il che dice anche quanto sia larga la falla di
un elenco che li mescola a chi chiede lo scontrino. Si apre con `/gratis`, o
dalla porta `🆓 Gratis` in 🎁 Tipi di premio (non dal menù: nel menù sarebbe la
stessa sezione da due posti).

### 💸 Con acquisto: l'altra metà, e il filtro che scavalca

"Quali chiedono di comprare?" è la stessa domanda dell'altra metà girata, e
adesso ha la sua porta accanto a 🆓 Gratis, il suo comando `/spesa` (o
`/acquisto`) e la sua sezione: `💸 Con acquisto (66)`.

Il vincolo è la colonna, non il tag: `requires_purchase = 1`, ordinato per
punteggio. Un concorso che chiede uno scontrino ma non scrive "acquisto" da
nessuna parte entra lo stesso; chi non dichiara niente resta in 🆓 Gratis perché
il default della colonna è 0. Insieme, le due sezioni coprono ogni concorso
attivo senza sovrapporsi.

Una cosa la sezione fa diversamente dalle altre, ed è dichiarata: **scavalca il
filtro 🎁 solo senza acquisto**. Quel filtro dice l'esatto contrario della porta,
e lasciarlo agire darebbe un elenco vuoto per costruzione (`requires_purchase =
0` sommato a `= 1`). Gli altri filtri — fonti spente, tag spenti, stelle minime,
marche seguite — valgono identici, e il numero sul bottone si accorcia con loro.
Aprire la sezione non accende né spegne niente: è una domanda secca, come
l'altra metà.

Misurato il 17/10/2026 sull'archivio vero: **160 concorsi attivi, 94 senza
acquisto e 66 con** — le due metà non si sovrappongono e non lasciano buchi.

### 🎁 Premio certo e 🛍️ Omaggi con acquisto: misurati prima di aprirli

Due cose che prima erano parole nel testo e adesso sono **contenuto di prima
classe**: un tag che le regole assegnano, una porta in 🎁 Tipi di premio con il
suo conteggio, una scorciatoia (`/premio-certo`, `/omaggi`), una pagina di wiki
e una voce in 🎛 Cosa vedi per spegnerle.

- **🎁 Premio certo**: il premio è garantito a chi partecipa, non un'estrazione.
  Il tag lo prende dalla formula della pagina ("premio certo", "premi certi",
  "premio garantito", "vincita garantita"), e la fonte che pubblica quel tipo di
  concorso lo dichiara già nel suo elenco;
- **🛍️ Omaggi con acquisto**: il regalo si riceve comprando (richiedi il set,
  ritiri il gadget, ricevi il buono). Il tag è **derivato**: serve la colonna
  `requires_purchase = 1` **e** un regalo scritto nel testo ("in regalo", "in
  omaggio", "richiedi …", "ricevi …") oppure un premio certo o una raccolta
  punti. Restano fuori le estrazioni con scontrino, i rimborsi e i coupon: un
  cashback non è un regalo.

**La misura, prima di aprire le porte.** Il 17/10/2026 ho letto dal vivo tutte e
32 le fonti (422 item grezzi) e poi l'archivio (252 item, 163 concorsi):

| Classe | Nell'archivio | Chi la pubblica davvero |
|---|---|---|
| 🎁 Premio certo | **25** | `scontrinofelice-premio-certo` 24 · `scontrinofelice-gratuiti` 1 |
| 🛍️ Omaggi con acquisto | **30** | `scontrinofelice-premio-certo` 20 · `scontrinofelice-raccolte-punti` 10 |

Sul giro dal vivo la formula "premio certo" compare **23 volte su 422 item**,
ventidue nella fonte dedicata; gli omaggi **14**, dieci dei quali sono premi
certi. Le altre trenta fonti ne pubblicano uno ciascuna o nessuno. È il dato che
decide il disegno: due porte e non due sezioni del menù, perché due voci di menù
per venti item della stessa fonte sarebbero rumore; e le porte si sovrappongono
di proposito, perché "è certo?" e "che cosa ricevo comprando?" non sono la
stessa domanda (5 premi certi non chiedono una spesa, 10 omaggi non dicono
"premio certo").

**L'archivio ha bisogno del riempimento.** I tag nascono all'ingestione, ma una
riga già in archivio non ripassa dall'arricchimento (il percorso caldo dei
duplicati lo salta quando la riga è completa). Il 17/10/2026 i tag nuovi erano
zero su 163 concorsi: `npm run tags` li ha aggiunti a 30 righe, in sola aggiunta
e senza toccare punteggi né date. Prima l'elenco, poi `--apply`; rilanciarlo non
cambia niente. Senza, le porte direbbero 0 fino al prossimo giro di raccolta —
e il numero sul bottone sarebbe l'unica bugia di questa schermata.

**Un limite dichiarato**: il riconoscimento è per formule. Un premio garantito
scritto in un modo che nessuna pagina usa oggi ("vinci sicuramente", "regalo
assicurato") resta fuori dalla porta, e un regalo descritto solo con l'immagine
pure. Meglio un elenco corto e vero che un elenco lungo da ripulire a mano.

### 📡 Fonti: chi ha risposto, senza aprire i log di GitHub

Alle prime raccolte la domanda è una sola — *chi risponde e chi no* — e fino a
oggi la risposta stava solo nella pagina del job su GitHub. Adesso ogni fonte si
porta dietro l'esito dell'**ultimo tentativo**, e la chat lo dice in una riga:
**l'ora, il codice HTTP e quanti item ha portato**.

```
🟢 Scontrino Felice · premio certo · 16/10 19:10 · HTTP 200 · 25 item
🔴 Tiscali · concorsi · 16/10 19:05 · HTTP 403 · ⚠️ 2 di fila
⚪️ Soldissimi · concorsi a premio · 16/10 19:10 · HTTP 304 · non è cambiata
🚫 Eni Più Insieme · concorsi · 16/10 19:10 · robots.txt vieta la raccolta
```

Le distinzioni sembrano pignoleria e non lo sono, perché **a occhio si
confondono**: un **403** e un **timeout** sono guasti diversi (il primo è la
fonte che ci rifiuta, il secondo una rete caduta — e senza codice HTTP resta il
messaggio dell'errore), un **200 con 0 item** è una fonte che risponde ed è vuota
(non è rotta: il numero degli item è lì proprio per distinguerla), un **304** è
una risposta — la pagina non è cambiata — e **robots.txt** non è né un guasto né
una risposta: siamo noi a non poterla leggere. Sono le stesse parole nel log,
nella schermata e in `/health` (`lastStatus`, `lastError`, `lastItems` per fonte),
perché il vocabolario degli esiti sta in un posto solo
([src/telegram/report.ts](src/telegram/report.ts)).

**Il racconto fonte per fonte** non arriva più in chat come messaggio: si salva
con l'esecuzione e si legge quando serve, in 🧾 Log delle raccolte (qui sotto).
Un riepilogo che si presenta da solo ogni mezz'ora diventa rumore, e il rumore si
smette di leggere; un log che sta al suo posto e si apre dopo aver cambiato una
fonte no.

### 🧾 Log delle raccolte: un log per ogni lancio (solo per l'admin)

Da 📡 Fonti, l'admin ha una porta in più: **🧾 Log delle raccolte**, con una
raccolta per schermata e il racconto **intero** di quel giro — quante fonti sono
state provate, quante hanno risposto, chi non ha risposto e perché, quanti item
sono arrivati — più le note della pipeline (una fonte che ha fallito tre volte di
fila, le fonti rimandate al giro dopo per budget). È lo stesso testo che il job
scrive nella sua pagina di riepilogo su GitHub, letto dal telefono.

```
🧾 Log delle raccolte · 1/12

GitHub · 20/11 10:30 · 30 ok / 2 errori · 185 nuovi

🧪 Raccolta su GitHub · 10:30
32 fonti provate, 30 hanno risposto, 2 no · 210 item letti, 185 nuovi

Non hanno risposto
🔴 Tiscali · HTTP 403
⚪️ Soldissimi · HTTP 304 · non è cambiata
```

Le frecce scorrono la storia (gli ultimi **20** lanci: con la raccolta ogni
mezz'ora sono circa dieci ore, e per la storia lunga c'è la pagina dei job su
GitHub), e ogni log dice da dove viene il giro — `GitHub`, `questo PC` o
`Raccolta di riserva (Worker)`, che è quella che parte dalla rete di Cloudflare
quando GitHub tace.

**La schermata è dell'admin, e non è un segreto:** l'altra persona ha le sue
sezioni e non ha niente da fare con i 403 di una fonte. Il gate è doppio — il
bottone non esiste nella sua tastiera, e la sezione non si apre nemmeno da un
`callback_data` vecchio (vedi `handleUpdate` in [src/telegram/bot.ts](src/telegram/bot.ts))
— perché un filtro solo è un filtro che prima o poi passa. Il comando `/log` (o
`/raccolte`) funziona anche scritto a mano, ma **non è pubblicato** nel menù "/"
di Telegram, che registra solo `/start` ([src/telegram/api.ts](src/telegram/api.ts)):
chi non lo conosce non lo trova scritto da nessuna parte.

**Perché i tick non ci sono**: il log lo scrivono le **raccolte** (`log` nella
tabella `runs`), non i tick da 15 minuti che consegnano gli avvisi e mettono via i
concorsi scaduti. Quindi l'elenco dei log è l'elenco dei **lanci veri**, senza
novantasei righe al giorno che non raccontano niente.

### 🌡 Diagnostica: quali fonti valgono la pena

📡 Fonti risponde a *chi ha risposto*. La domanda che viene dopo è un'altra — *e
questa fonte serve a qualcosa?* — e sono due cose diverse: una fonte che risponde
benissimo può non aver portato un concorso in un mese (pattern troppo stretto,
pagina che è un catalogo, feed che ripubblica sempre cose già viste altrove).
Sono esattamente quelle che conviene togliere per far posto a un'altra, e prima
di oggi l'unico modo di accorgersene era contare a mano gli item per fonte.

`/diagnostica` (o 🌡 dalla schermata 📡 Fonti) dà **un verdetto per fonte**, con
il fatto e che farne, e i gruppi sono i verdetti:

| Gruppo | Verdetti | Cosa vuol dire |
|---|---|---|
| Falliscono | 🔴 `rotta` · 🟠 ultimo giro fallito | tre fallimenti di fila (o appena fallita): prima di questa, ogni altra spiegazione è prematura |
| Rispondono ma non portano concorsi | 🟠 `catalogo` · `muta` · 🟡 `vuota` | ha letto pagine e ne ha scartate, o ha letto item e nessuno è diventato un concorso, o risponde senza aver mai portato niente |
| Non portano più niente di nuovo | 🟡 `ripete` · `esaurita` | vede concorsi che in archivio hanno fatto entrare gli altri, o non ne porta da più di un mese |
| Da controllare a parte | ⚪️ `mai-provata` · `non-provata` | non è un motivo per toglierla: la rotazione del Worker ne tocca poche per volta, e questo è un limite del Worker, non della fonte |

Le regole stanno in [src/sources-health.ts](src/sources-health.ts), pure e
senza database, con le soglie esportate (`ROTTA_DA_FALLIMENTI`,
`NON_PROVATA_DA_MS`, `ESAURITA_DA_MS`): il perché di un verdetto si legge senza
scavare nel codice. Il contributo di ogni fonte lo legge lo store (`sourceStats`,
[src/db/store.ts](src/db/store.ts)) e sono **due misure diverse di proposito**:

- **concorsi** = gli item ancora in archivio arrivati per primi da lei;
- **viste** = ogni concorso che ha visto, anche se in archivio era già entrato da
  un'altra, e di quelle **quante ha scartato** il cancello di freschezza.

È questa seconda misura che distingue le due fonti che a occhio si confondono:
quella che **ripete** (molte viste utili, zero concorsi: vale solo come conferma)
e quella che porta **catalogo** (molte pagine scartate: il pattern pesca la
pagina sbagliata). Una fonte riconosciuta come catalogo non può essere anche
"che ripete", perché le viste scartate non sono concorsi visti.

Il verdetto **non è un ordine di cancellazione** — è un indizio, e la schermata
lo dice: per togliere una fonte si mette `enabled: false` nella sua voce di
[src/config/sources.ts](src/config/sources.ts) e si lancia `npm run db:sync`; per
non vederla solo per sé, senza toccare il codice, basta 🎛 **Cosa vedi** →
**Scegli le fonti**.

Due dettagli che servono a fidarsi dell'elenco: le fonti sane si **contano**
invece di essere elencate una per una, e le voci che non ci stanno in un
messaggio (il limite di Telegram, 4096 caratteri, meno il margine) restano
nell'elenco **con il loro id** — il motivo è già scritto per il gruppo, ma l'id è
la parte su cui si agisce, e nasconderla toglierebbe proprio una delle fonti da
togliere.

### ⚙️ Impostazioni: le tre cose che si regolano

`/impostazioni` (o ⚙️ nel menù) è l'unica schermata che cambia qualcosa: soglia
degli **avvisi immediati**, **fascia di silenzio** e **orari dei digest**. Valgono
**solo per la tua chat**, come i filtri e i pesi.

Ogni voce si regola di fino e di solito:

| Cosa | Di fino | Di solito |
|---|---|---|
| 🔔 Avvisi immediati | `➖ 5` / `➕ 5`, da 0 a 100; ai bordi il cursore c'è ma è inerte, così la riga non si sposta sotto il dito | `60` `70` `80` `90` |
| 🌙 Silenzio | due cursori, `dalle` e `alle`, un'ora per tocco: dalle 23 alle 22 **allunga** la fascia all'indietro, alle 7 alle 8 la allunga in avanti | `23–7`, `22–8`, `Off` |
| 📬 Digest | le **24 ore** una per una: un tocco accende l'ora, lo stesso tocco la spegne | `8 + 19`, `7 + 13 + 20`, `Off` |

Dentro la **fascia di silenzio** non parte nessuna notifica — avvisi immediati,
digest, promemoria della watchlist (raccolte punti comprese) e promemoria della
raccolta ferma — e gli item
restano in attesa del digest successivo. Con il silenzio spento i due cursori
partono dalla fascia solita (23–7) e lo riaccendono: chi tocca ➖ ➕ vuole una
fascia, e `Off` resta a un tocco per disfarlo.

Le ore del **digest** valgono anche nell'ora prima e in quella dopo (è la
tolleranza per l'ora legale, in `isDigestWindow` in [src/schedule.ts](src/schedule.ts)):
8 e 9 accese sono quasi la stessa richiesta. Spegnendo l'ultima ora il digest si
ferma, e la chat lo dice invece di lasciare la griglia tutta spenta senza
spiegazione.

I conti dei cursori stanno in un posto solo, [src/telegram/prefs-config.ts](src/telegram/prefs-config.ts):
la tastiera ci scrive il valore sul bottone e il router lo rilegge da lì, quindi
un bottone disegnato non può essere scartato al tocco (le fasce girano sulla
giornata — 23 + 1 → 0 — e restano sempre ore vere).

## 6. Deduplica: perché è fatta così

Prima di scrivere la regola ho misurato 10 coppie di duplicati veri (stesso
concorso su fonti diverse) e 10 coppie di concorsi diversi:

| Segnale | Duplicati veri | Concorsi diversi |
|---|---|---|
| Distanza di Hamming (SimHash) | 10-20 | da 8 in su |
| Somiglianza Jaccard sui token | 0,63-1,00 | fino a 0,75 |

Il solo SimHash **non separa** le due popolazioni: come giudice darebbe falsi
accoppiamenti. La regola finale è quindi a due stadi:

1. **prefilter**: SimHash con soglia larga (≤ 32) per non scansionare tutto;
2. **giudice**: `isDuplicateTitle` → Jaccard ≥ 0,6 sui **token distintivi**
   (le parole generiche come *vinci, concorso, premio, euro, spesa* vengono
   ignorate) **e** importi coerenti (`1000 euro` ≠ `500 euro`).

Prima di confrontare, il titolo viene ripulito dal nome della fonte (gli
aggregatori antepongono il proprio marchio, "Scontrino Felice - Concorso…") e dal
boilerplate ("[…] Leggi l'articolo: …").

Risultato misurato su quel campione: **10 duplicati su 11 riconosciuti, 0 falsi
accoppiamenti** (11ª coppia: `1000 euro` vs nessun importo, che ora la regola
unisce). La scelta è deliberata: un duplicato mancato costa un messaggio in più,
un falso accoppiamento costa un concorso perso. Le stesse coppie sono bloccate
come test in [test/text.test.ts](test/text.test.ts) e
[test/dedupe.test.ts](test/dedupe.test.ts).

**Quando vincono due copie dello stesso concorso, in archivio resta il nome
migliore.** Un duplicato non crea una seconda riga, ma può portare un nome più
completo: se il candidato contiene tutte le parole del titolo già salvato e ne ha
altre — o se ha le stesse parole scritte meglio — il titolo in archivio viene
aggiornato (insieme al suo SimHash, che è la firma di quel titolo). Il caso
misurato: la sitemap di Scontrino Felice dà lo slug, il suo feed il titolo vero, e
prima vinceva quella che capitava per prima. In ogni altro caso il nome in
archivio non si tocca: meglio un nome imperfetto che uno sostituito con uno
peggiore.

## 7. Punteggio e antispam

Punteggio 0-100 (`src/enrich/score.ts`), pesi trasparenti: valore del premio
(30), sforzo richiesto (20), scadenza entro 3 giorni (18) o 14 (12), freschezza
(12/6), nessun obbligo d'acquisto (10), parole chiave come *gift card* o
*in palio* (5), più bonus/malus dai tuoi feedback (±1 per tag) e **10 punti per
una marca che segui** (🏷 Marche seguite).

Le regole di arricchimento estraggono scadenza (date numeriche e "30 novembre
2026", con inferenza dell'anno), premio (importi e marche, comprese le auto
citate solo per marca), modalità di partecipazione e sforzo. Workers AI
(`@cf/meta/llama-3.1-8b-instruct`) interviene **solo** sugli item senza scadenza
né premio, massimo 3 chiamate per esecuzione e con un tetto giornaliero di
10.000 Neurons: oltre il tetto si torna alle regole, senza errori.

Freni antispam, tutti attivi per default:

| Regola | Valore |
|---|---|
| Concorsi per digest | max 8 (`…e altri N su /oggi`) |
| Digest vuoto | non viene inviato |
| Avvisi immediati | max 2 per esecuzione, uno ogni 20 minuti, solo item scoperti da ≤ 3 ore |
| Marche seguite | scavalcano **solo** la soglia del punteggio; gli altri freni restano |
| Fascia di silenzio | 23:00-07:00 italiane (è il default: si cambia da ⚙️ Impostazioni) |
| Primo giro | nessun avviso immediato |
| Notizie fuori tema | filtrate sulle fonti Google News |
| Fonte rotta | 3 errori di fila → **un solo** avviso all'admin |

## 8. Fonti monitorate

Verificate il 16/10/2026 (feed leggibili senza login): Scontrino Felice
(**quattro** sezioni: con acquisto, gratuiti, premio certo, raccolte punti),
DimmiCosaCerchi, Vincimi, più sei query Google News, alcune sitemap — e, dallo
stesso giorno, **sei feed di coupon e rimborsi** (la ricognizione e i motivi
delle esclusioni stanno qui sotto). L'elenco completo con stato di verifica è in
[src/config/sources.ts](src/config/sources.ts).

**Ricambio del 17/10/2026.** In produzione cinque fonti non portavano più un
item: `soldissimi` (otto giri di 403 di fila), `premieconcorsi` e la sua sitemap
(403 dal runner GitHub, anche se dal PC rispondono 200: è la protezione bot del
sito a rifiutare gli IP da datacenter), `sitemap-burgerking` e `sitemap-payback`
(zero item in tutta la storia), `scontomaggio-cashback` (un coupon) e i due feed
coupon di scontOmaggio, che dal runner ricevono una pagina di verifica (**202 con
0 item**) invece del feed.

Le sostituzioni sono state misurate **due volte**: dal PC con i parser veri, e poi
nel primo giro di produzione dal runner GitHub, che è l'unica rete che conta
(vedi `.github/workflows/ingest.yml`). Il secondo passaggio ha cambiato il
verdetto: **Your Contest** (10 concorsi nuovi) e **CouponVolantini** (9 rimborsi
con l'importo nel titolo) hanno risposto 200 e sono in archivio; **OmaggioMania** e
**scontOmaggio · concorsi con acquisto** hanno risposto 202 con 0 item dal runner
(10 concorsi dal PC) e sono state rispente — un 202 non è un errore HTTP, quindi
una fonte così resta verde nei log mentre non porta niente. **Penny** ed
**Eurospin** hanno risposto 200 ma scartato tutte le 20 pagine lette, e qui è
saltata fuori la causa vera: il runner esegue il codice del **commit**, non il
working tree, e quelle due fonti erano nuove — quindi senza `includePattern`.
Senza filtro una sitemap restituisce le prime venti pagine del sito (catalogo e
indici), che il cancello di freschezza butta. Dal PC, con il pattern giusto,
sono 6 pagine e 2 concorsi attivi a testa. Ora `include_pattern` e `max_items`
viaggiano in D1 accanto alla fonte (`npm run db:sync` li semina) e
[resolveSource](src/pipeline.ts) preferisce la riga alla configurazione: un
pattern cambiato arriva al runner senza aspettare il push. Penny ed Eurospin
restano spente finché questa modifica non è pubblicata, poi si riaccendono.

La query `news-raccolta-punti` non è stata sostituita ma **riscritta**: `"raccolta
punti" vincita` non trovava niente, `("raccolta punti" OR bollini OR "collezione
punti") concorso` trova le tre parole con cui le insegne annunciano davvero una
raccolta (3 item in un giro, tutti veri). Il trasporto — news.google.com — è uno
dei pochi che risponde sempre anche dal runner. Carrefour è stata provata e
scartata: 10 pagine lette e 10 scartate.

Il conto finale: da 31 fonti accese a 27. Le quattro in meno sono fonti che in
produzione non portavano item, e non sono state rimpiazzate per forza — un elenco
più corto e tutto verde vale più di uno lungo con caselle che non rispondono.
Il giro di produzione che ha fatto da collaudo (11:45 UTC) chiude con **zero fonti
in errore**, e i nuovi arrivati hanno portato 10 concorsi (Your Contest), 9 coupon
(CouponVolantini) e 3 item dalla query riscritta.

**Scontrino Felice** è la fonte più ricca, e la sua sitemap e i suoi feed
pubblicano gli **stessi URL**: la deduplica li tiene come una riga sola e vince il
nome più completo (vedi la sezione 6). Misurato il 16/10/2026 sulle sue sole
cinque fonti: **87 concorsi, 87 URL distinti, zero titoli mozzi**, e al giro
successivo 0 nuovi su 20 riletti. Si legge con i suoi feed e non dalla sitemap
perché i feed portano il titolo vero ("Concorso Lievital: vinci Forni e
Scaldavivande") mentre la sitemap porta lo slug ("Concorso Lievital"): 25 item per
sezione, che è tutto quello che il sito tiene in vetrina.

È anche l'unica fonte che pubblica **premi certi** e **omaggi con acquisto** su
larga scala: misurato il 17/10/2026, 24 dei 25 premi certi e 20 dei 30 omaggi
vengono dal suo feed `premio-certo`; dieci raccolte punti arrivano da
`scontrinofelice-raccolte-punti`. Le altre fonti ne portano uno ciascuna, o
nessuno: è la ragione per cui le due porte esistono, ma i loro numeri restano
piccoli.

**I brand, andando alla fonte.** Gli aggregatori non coprono i concorsi che
un'azienda pubblica solo sul proprio sito: l'unico modo è guardare le **sitemap e
le pagine promozionali** dei marchi.

Il 16/10/2026 ne ho sondati **cinquantuno** uno per uno (barilla, mulino bianco,
findus, nutella, kinder, algida, perugina, san pellegrino, galbani, parmalat,
granarolo, bauli, maina, rio mare, amadori, de'longhi, nespresso, mediaworld,
unieuro, decathlon, douglas, nivea, pampers, chicco, enel, q8, toyota, kia,
samsung, philips, costa, msc, autogrill, vodafone, iliad, bennet, eurospin, lidl,
carrefour, coop, despar, cisalfa, zalando, sephora, kiko, beretta, citterio,
aiofood, yomo…), leggendo robots.txt e sitemap come fa la raccolta. Il risultato:
**ventitré non hanno una sitemap leggibile** (Barilla, Mulino Bianco, Kinder,
Nutella, Findus, Granarolo, UniEuro, Eurospin…) o non espongono i concorsi in un
file XML, **sedici avevano URL che sembrano concorsi** ma per la maggior parte
erano falsi positivi (le pagine "premium" di Vodafone e Cisalfa, i listini di
Toyota ed Enel, i prodotti "Premium" di Carrefour), e **sei avevano pagine di
concorso vere**. Di quelle sei, tre portavano solo la pagina della sezione
(Galbani, Parmalat, Rio Mare) e una solo campagne senza nessuna parola di
concorso nello slug (Nivea). Sono entrate le due che con i parser veri hanno
prodotto concorsi veri: **[AIA](src/config/sources.ts)** (`/concorsi/…`, 1
concorso attivo) e **Pampers** (`/concorsi-a-premi-e-promozioni/…`, 1).

**L'ordine di una sitemap non è il nostro.** Le sitemap elencano le pagine dalla
più vecchia, e con un tetto di 20 pagine prendere le prime venti vuol dire
leggere il 2023 per sempre: sulla sitemap di AIA le prime venti erano tutte del
2023 e i concorsi del 2026 — compreso quello uscito il 15 ottobre — non venivano
mai letti, quindi il cancello di freschezza li scartava tutti e la fonte
sembrava vuota. Dal 17/10/2026 [parseSitemap](src/ingest/sitemap.ts) raccoglie
**tutte** le pagine che passano `includePattern` e poi tiene le più recenti per
`<lastmod>`; chi non dichiara la data resta in coda nell'ordine del file, perché
una data assente non si inventa. Effetto misurato con `ingestSource` sulle fonti
vere: AIA passa da venti pagine del 2023 a quelle del 2026 (15/10 e 07/10
accettate), Conad dai tre concorsi mai letti in fondo al file ai primi tre — che
però restano scartati per un altro motivo (vedi sotto).

Poca roba, ed è il punto: le marche pubblicano i concorsi in una pagina sola o
dietro JavaScript, e le sitemap servono a trovare quella pagina. Il valore non è
la quantità, è che **quei concorsi gli aggregatori non li hanno** — AIA e Pampers
non comparivano in nessuna delle nostre altre fonti. La stessa prova ha fatto
emergere un buco nel cancello di freschezza: le pagine che annunciano i vincitori
(\"I Vincitori 2013\") entravano in archivio come concorsi, perché la parola
\"vincitori\" contava solo dentro una frase di chiusura. Ora un titolo che
*comincia* con \"vincitori\" vale come chiusura, e \"incontra il vincitore di
X Factor\" resta un concorso vivo.

**Il resto dei marchi.** Gli aggregatori non coprono i concorsi che un'azienda
pubblica solo sul proprio sito, e le fonti qui sotto sono state provate una per
una con i parser veri (16/10/2026). Le fonti qui sotto sono state provate una per una con i parser veri
(16/10/2026) e sono entrate in configurazione solo quelle che restituivano
pagine di concorso: le altre (Barilla, Mulino Bianco, Perugina, McDonald's,
Findus, Algida, Heineken, Trenitalia, TIM, WindTre, Esselunga…) rispondono 403,
non hanno un elenco pubblico o lo costruiscono via JavaScript, quindi non sono
monitorabili in modo affidabile — restano coperte dalle query Google News.

La colonna dice cosa **entra** dopo il cancello di freschezza, che è la differenza
tra "una pagina del sito" e "un concorso": senza di lui una sitemap di brand porta
anche i cataloghi di tazze e borse e le promozioni chiuse anni fa.

| Fonte | Tipo | Cosa entra (misura del 16/10/2026) |
|---|---|---|
| Ferrero · promozioni | sitemap | 2 su 20 pagine (`vinciwonka2026`, `vincimomentiinsieme2026`); le altre sono raccolte punti e gadget senza la parola del concorso nello slug |
| Lavazza · concorsi | sitemap | 1 pagina (regolamento); con il pattern largo erano 20 kit di prodotto |
| Conad · carte e premi | sitemap | 2 promozioni vere (`vincibici`, `giro-d-italia-vincigiro`); il catalogo di tazze, borse e peluche resta fuori |
| Burger King · regolamenti | sitemap | 0: le due pagine che ha sono del 2024 e 2025 — **spenta il 17/10/2026**, senza sostituta |
| Eni Più Insieme · concorsi | sitemap | 6 su 6 (i concorsi hanno nomi di premio, la sezione `/concorsi-premi/` è il segnale) |
| PAYBACK · regolamenti | sitemap | 0: 5 regolamenti dal 2018 al 2021, e le 5 pagine lette erano tutte indici — **spenta il 17/10/2026**, senza sostituta |
| Penny · concorsi e collezioni | sitemap | 2 su 5 pagine dal PC (`concorso-prodotto-misterioso`, `concorso-paga-penny`), ma **0 item dal runner**: 20 pagine lette e 20 scartate — **spenta** |
| Eurospin · concorsi | sitemap | 2 su 9 pagine dal PC (`la-partenza-intelligente`, `bluey`), ma **0 item dal runner**: 20 su 20 scartate come "pagina indice" — **spenta** |
| Sammontana · gusta e vinci | sitemap | 3 pagine |
| Coca-Cola · offerte e concorsi | pagina HTML | 3 campagne su 5 (le altre due non sono concorsi) |
| Premi e Concorsi · sitemap | sitemap | 0: pubblica solo tassonomie ("Concorsi Fotografici"…), i concorsi arrivano dal suo feed RSS |
| Google News · brand | query | Nutella, Kinder, Coca-Cola, Mulino Bianco, supermercati |
| Google News · instant win | query | concorsi con codici sotto il tappo, "in palio" |

**Coupon e rimborsi: la ricognizione del 16/10/2026.** La domanda era dove
stiano i buoni sconto italiani — quelli che si stampano o si riscattano al
supermercato — e i rimborsi con lo scontrino, perché **nessuna delle fonti già
in elenco ne pubblica un elenco**. Ho sondato con i fetcher veri del progetto
(robots.txt compreso, stessa User-Agent della raccolta) **ventuno candidati**:
feed di coupon, aggregatori di codici sconto, sitemap di negozi e insegne.

Il risultato divide i candidati in due gruppi netti. **Le tre testate che
pubblicano un feed di coupon e rimborsi** lo fanno davvero, e sono entrate con
due sezioni ciascuna (una per i buoni, una per i rimborsi): **Scontrino Felice**,
**DimmiCosaCerchi** e **scontOmaggio**. **Gli aggregatori di codici sconto**
(Topnegozi, Widilo, CodiceRisparmio, DoveConviene, Tigotà) rispondono 200 ma
pubblicano il **catalogo dei negozi**, non le offerte: le loro pagine di negozio
(`codice-sconto/24bottles`, `negozi/douglas`) escono venti per volta, e la pagina
di un negozio è a sua volta un elenco di categorie ("Moda & Accessori",
"Elettronica") o addirittura il carrello e l'assistenza del sito. Da lì non esce
un buono, quindi sono fuori. **Le insegne** (Conad, Acqua & Sapone, Esselunga)
tengono i buoni nell'app o sulla carta fedeltà e non pubblicano nessun elenco
leggibile: le loro promozioni arrivano da qui, perché queste tre fonti le
raccontano. Le pagine di campagna delle sitemap Conad e Carrefour esistono, ma
non elencano i buoni: il terzo sondaggio qui sotto dice cosa c'è dentro.

| Fonte coupon | Feed | Cosa entra (misura del 16/10/2026) |
|---|---|---|
| Scontrino Felice · spendi e riprendi | `/spendi-e-riprendi/feed/` | 20 item: i rimborsi con scontrino, più i cashback che annunciano anche un premio (quelli restano concorsi) |
| Scontrino Felice · buoni sconto | `/buoni-sconto/feed/` | 20 item, **zero concorsi**: è la sezione dei buoni veri (Novi, Aia, Président, Regina) |
| DimmiCosaCerchi · cashback | `/cashback/feed` | 15 item: rimborsi (Braun, L'Oréal da Acqua & Sapone, Amazon) e i concorsi-cashback |
| DimmiCosaCerchi · buoni sconto | `/buoni-sconto-da-stampare/feed` | 15 item, quasi tutti coupon |
| scontOmaggio · operazioni a cashback | `/cashback/feed/` | 16 item di rimborsi (Fabuloso, Braun, L'Oréal) |
| scontOmaggio · buoni sconto | `/coupon/feed/` | 16 item, quasi tutti coupon (CremaNovi, Multicentrum, Regina) |

La sitemap di Scontrino Felice porta gli stessi buoni (`/buoni-sconto/…`, 3 URL
nell'ultimo giro) ma con lo **slug** al posto del titolo, quindi anche qui si
leggono i feed, come per i concorsi. Il risultato in archivio, con la pipeline
vera: **67 coupon**, 4 concorsi ibridi e 31 offerte fermate all'ingresso perché
troppo vecchie (18 + 8 + 5).

**Un'offerta, una riga.** Tre feed di coupon raccontano spesso la stessa
promozione con tre frasi diverse ("Rimborso di 5 € su Nutella", "Cashback
Nutella: 5 € di rimborso", "5 euro indietro su Nutella"): per la deduplica
dell'ingestione sono titoli diversi, quindi nella **classifica della convenienza**
di 💶 Coupon la stessa offerta poteva comparire tre volte con lo stesso
rapporto. Da qui
[mergeIdenticalOffers](src/refunds.ts): prima di ordinare per convenienza le
righe si uniscono quando dichiarano **lo stesso rimborso** (stessa cifra, stesso
tetto), non si contraddicono sulla **spesa** e hanno in comune almeno una parola
di prodotto (la marca conta solo come vincolo: se le due marche dichiarate sono
diverse, non si unisce). L'importo uguale da solo non basta: due "Rimborso di
5 €" senza un prodotto in comune restano due righe, perché nasconderne una
sarebbe peggio che mostrarne due; e nemmeno la marca uguale basta ("Aia Durango
0,50 €" e "Aia Spinacine 0,50 €" sono due buoni). L'unione è **di
visualizzazione**: l'archivio resta una riga per fonte (le viste si contano in
📈 Vantaggio), cambia solo quello che si legge — riga rappresentante quella che
racconta di più. La regola vale nella classifica; le altre viste dei coupon
(🗂 Tutti, 📋 Oggi…) restano per fonte e per data di arrivo.

Misura sui feed veri del 17/10/2026 (Scontrino Felice, DimmiCosaCerchi,
CouponVolantini, 85 item): **85 righe → 73**, cioè 12 copie unite, tutte
coppie vere (Ymea menopausa da tre fonti, Parodontax, Ambipur, AIA da Despar,
Gillette Usa e Getta…). La prova ha fatto emergere una falsa unione che i test
ora fissano: con la parola in comune lunga tre lettere, "usa" di "Gillette usa e
getta" univa Parodontax e Gillette. `rankByConvenience` fa unione e ordinamento
in una passata sola perché leggono le stesse due cifre: 200 righe costano ~1,4
ms in Node, e su Workers Free il tetto è 10 ms.

Il limite dichiarato: chi non dichiara una cifra di rimborso non si unisce —
"buono sconto" senza importo (o "rimborso del 50%") resta una riga per fonte,
perché senza una cifra non c'è niente di verificabile da confrontare.

**Secondo sondaggio, 17/10/2026.** La domanda era se esistano altri siti di coupon
con un feed, e la risposta misurata è **no**: `PromoQui`, `DoveConviene`,
`Tiendeo` rispondono 200 ma servono **HTML**, non un feed; `Prezzonauta` espone
un RSS **vuoto** (1 KB, zero item); `scontOmaggio` risponde **403** anche al feed
generale; `Coupon.it` non risponde; `Sconti.it` e `BuoniSconto.it` sono 404 sul
percorso `/feed/`. Restano quindi le fonti che già ci sono, più
**CouponVolantini** (`/feed/`, 10 item, 200) che è subentrata a scontOmaggio.
La conclusione pratica: il collo di bottiglia non sono le fonti ma la
**classificazione** — le insegne (Esselunga, Conad, Coop, Carrefour, Pam, Lidl)
tengono i buoni nell'app o in PDF, e chi li racconta pubblica un feed — ed è per
questo che la sezione coupon ha ora le viste e non un elenco unico.

**Terzo sondaggio: le insegne hanno una sitemap, ma è vuota di campagne.** La
domanda era se le campagne spendi-e-riprendi di Conad e Carrefour si possano
leggere dal sito ufficiale invece di aspettare che un blog le racconti. Si può —
le sitemap sono pubbliche, robots.txt le permette e i pattern trovano le pagine —
ma il 17/10/2026 non c'era **niente da raccogliere**: misurato con `ingestSource`
sulle sitemap vere, **26 pagine su 26** (Conad 12, Carrefour 14) sono state
classificate coupon e poi scartate dal cancello di freschezza come "offerta
vecchia" — le più recenti erano di 98 giorni (Carrefour, tecnologia) e di 499
(Conad, che ha tutte le landing ferme al 2025-06-05 per un aggiornamento di
massa del sito). Sono campagne stagionali: quando non c'è, la pagina resta su.

Le due fonti sono quindi in configurazione (`sitemap-conad-spendi`,
`sitemap-carrefour-spendi`) ma **spente**, con il pattern già fissato nei test:
accenderle oggi vorrebbe dire una fonte a zero item per mesi, cioè lo stesso
motivo per cui sono spente Burger King, PAYBACK, Penny ed Eurospin. Si accendono
alla prima campagna con `lastmod` entro i 60 giorni dei coupon, e non serve
toccare il codice. C'è anche un motivo di costo, misurato: la sitemap di Conad è
un unico urlset da **442 KB e 3443 URL**, ~21 ms di parse in Node — da sola
sfonda i 10 ms di CPU del piano Free, quindi Conad resta spenta anche a campagna
fresca finché non si passa a Workers Paid. Quella di Carrefour è 50 KB e ~1,2 ms,
quindi è solo il contenuto a mancare.

**Esselunga no.** Ha una sitemap da 2220 URL con **due** pagine cashback:
`cashback.html` risponde 200 ma è un guscio JavaScript senza testo di campagna, e
`cashback-smartphone.html` è 404. Zero offerte da leggere: essendo un negozio che
tiene i buoni sulla Carta Fidaty, resta coperta dai feed e dalle query Google
News, come le altre insegne.

Esclusi con il motivo, perché la ricognizione serve a non riprovarli:
**OmaggioMania** è escluso come fonte di **coupon** — il feed generalista mescola
omaggi con acquisto, volantini e concorsi, e le offerte da spendere sono la
minoranza — ma dal 17/10/2026 il suo feed **concorsi** è acceso come fonte di
concorsi (10 item nuovi, tutti di marca); **SpesaBack** pubblica la home, la guida
e il "come funziona", non le offerte.

Misura della prima raccolta completa con tutte le fonti (22 su 22, 16/10/2026):
**267 item letti, 213 nuovi, 32 duplicati, 22 fuori tema, 0 errori**, in 9 secondi.
Prima di queste fonti la stessa raccolta ne trovava 99. Il cancello di freschezza è
arrivato dopo: sulle fonti di elenco scarta la maggior parte di quello che legge
(Conad 18 su 20, Ferrero 18 su 20, Burger King 18 su 18), e i 54 falsi positivi che
erano già in archivio — tassonomie di Premi e Concorsi, catalogo Conad, kit Lavazza,
la promo Conad del 2024 — sono stati tolti con `npm run prune -- --apply`.

**Aggiungere una fonte**: aggiungi una voce in `SOURCES` (basta `id`, `name`,
`kind`, `url`, `category`, `tags`, `cadenceMin`), poi `npm run db:sync` e
`npm run deploy`. `db:sync` semina anche `includePattern` e `maxItems` nelle
colonne `include_pattern` / `max_items` di `sources`: sono loro, a runtime, a
dire al runner come leggere la pagina, e senza quella semina una fonte nuova
arriva al runner senza filtro (che su una sitemap vuol dire leggere il catalogo).
Per una fonte di **offerte** basta dichiarare
`category: "coupon"`: la classificazione la legge e i suoi item finiscono in
💶 Coupon e rimborsi invece che fra i concorsi, senza altra configurazione. Le
fonti marcate `enabled: false` sono da validare a mano
(i selettori/pattern non sono ancora verificati sul markup reale).

**Rimuoverne una**: imposta `enabled: false` e riesegui il seed, oppure
disattivala dal database (lo stato in D1 comanda a runtime).

### Checklist di chiusura: quando un cambiamento alle fonti è finito

Vale per ogni modifica alle fonti: una voce nuova in `SOURCES`, un pattern
stretto meglio, una `category` cambiata, una fonte spenta. Le quattro caselle
sono in quest'ordine, e ognuna risponde a una domanda diversa — le prime due le
puoi fare subito, la terza e la quarta dicono se il cambiamento è arrivato dove
serve.

**Un comando solo**: `npm run checklist` le esegue tutte, nell'ordine, e stampa
una casella per riga con i controlli sotto — `[x]` torna, `[!]` torna ma c'è da
guardare, `[ ]` non torna, `[-]` da fare a mano — e l'esito di D1 fonte per
fonte. Non scrive niente: la prova dal vivo usa un archivio in memoria e D1 si
legge soltanto. Con `--fonte <id>` la prova dal vivo legge solo quella fonte e
la casella 3 controlla anche i tipi dei suoi item; `--senza-rete` salta la prova
dal vivo, `--senza-test` salta typecheck e suite. Esce **1** se una casella non
torna, quindi si può mettere in una pipeline. Quello che segue è cosa guarda
ogni casella e perché: serve quando una non torna.

**1. Il codice regge**

- [ ] `npm run typecheck` (esce 0) e `npm test`: la suite **intera**, non il solo
      file che hai toccato. Le fonti parlano con la classificazione, il cancello
      di freschezza, la deduplica e il punteggio: una `category` o un
      `includePattern` cambiati spostano righe da una sezione all'altra, e il test
      che se ne accorge spesso è in un file che non hai aperto.

**2. La fonte parla davvero (prova dal vivo, senza scrivere niente)**

- [ ] `npm run dry-run -- --tutte`, con i **fetcher veri** del progetto e
      robots.txt compreso. Il flag è il punto: senza, la prova usa la **rotazione
      a slot** del Worker (`dueSources`), quindi legge solo le fonti che toccano a
      questo quarto d'ora — una fonte nuova può non comparire affatto e sembrare
      rotta mentre il suo slot è semplicemente un altro. `--tutte` è la stessa
      selezione della raccolta esterna, e la prima riga stampata è la prova che
      sta leggendo proprio quelle (32 il 16/10/2026). Nelle note guarda due cose:
      il codice HTTP di ogni fonte e i motivi degli scarti (`N scartati, non
      attivi (…)`).
- [ ] Per una fonte **nuova** la domanda non è "risponde?" ma "cosa entra?": una
      sitemap con tutti gli scarti a `nessun segnale di concorso` ha il pattern
      troppo largo, un feed con tutti gli scarti a `offerta vecchia` è un
      arretrato di mesi.
- [ ] Un `🚫 robots.txt vieta la raccolta` non è un guasto: è il rispetto della
      regola, e la fonte resta in elenco con quello stato.
- [ ] Una fonte che risponde **200 da qui e 403 dalla rete di Cloudflare** resta
      in elenco, ma i suoi item arrivano solo dalla raccolta esterna: `npm run
      ingest` da un PC, o GitHub Actions quando i tre secret ci sono. Misurato il
      16/10/2026: le testate `dimmicosacerchi` e `scontrinofelice` si comportano
      così, e nel Worker quei 403 sono **attesi**, non un guasto da inseguire —
      nell'elenco delle fonti si vedono come 🔴, e sono la ragione per cui la
      raccolta non vive nel Worker.

**3. L'archivio lo conferma (D1, in produzione)**

```bash
npm run db:sync   # lo stato in D1 comanda a runtime: senza il seed la fonte nuova non ha una riga sua
```

- [ ] La riga della fonte è **sana**. Due esiti sono sani, e non sono lo stesso
      esito: `last_status = 200` con `last_items > 0` (la fonte ha risposto e ha
      portato item) e `last_status = 304` con `last_items = 0` (il feed non è
      cambiato dall'ultima lettura — è lo stato di regime, e uno zero lì non è un
      guasto). Quello che non va bene è un 4xx/5xx (`403`, `404`, `429`) o
      `fail_streak` sopra 0: a tre fallimenti di fila arriva l'avviso in chat.
      `last_status` è l'ULTIMO tentativo, quindi un 200 di ieri non vale se
      l'ultimo giro è andato male:

```bash
npx wrangler d1 execute concorsi-radar --remote --command \
  "select id, enabled, last_status, last_error, last_items, fail_streak from sources where id = 'scontomaggio-coupon'"
```

- [ ] Gli item sono nella sezione giusta, e la prova è il **tipo**, non il
      titolo: una fonte di coupon che produce `contest` sta dichiarando male la
      categoria, una sitemap di brand che produce `news` sta portando contenitori
      (che è la risposta giusta: i contenitori vanno in news).

```bash
npx wrangler d1 execute concorsi-radar --remote --command \
  "select kind, count(*) as n from items where source_id = 'scontomaggio-coupon' group by kind"
```

- [ ] Il **numero** di righe non è una misura di salute della fonte: lo stesso
      buono arriva da tre feed e la deduplica tiene la prima riga, quindi
      `scontomaggio-coupon` in produzione ne ha **1** accanto ai 21 di
      `scontrinofelice-cashback` (16/10/2026) senza che niente sia rotto. Il dato
      che conta è il **tipo**, e `scontrinofelice-cashback` fa esattamente le tre
      cose che deve: 21 `coupon`, 3 `contest` (i rimborsi che annunciano anche un
      premio) e 1 `news`.

- [ ] Il bilancio non si è spostato di lato: `select kind, status, count(*) as n
      from items group by kind, status`. Se i coupon sono raddoppiati senza che tu
      abbia acceso una fonte di coupon, la classificazione sta rubando concorsi.
- [ ] Il giro ha lasciato la sua nota: `select trigger, substr(note,1,80) as nota,
      started_at from runs order by started_at desc limit 3` — `actions` è la
      raccolta su GitHub, `local` un giro lanciato a mano, un'espressione cron è
      il tick del Worker. Un giro che non compare qui non ha scritto niente.

**4. La chat lo mostra**

- [ ] La sezione che hai toccato si apre e conta quello che ti aspetti: `/coupon`,
      📡 **Fonti** per l'esito dell'ultimo tentativo di ogni fonte, 🌡
      **Diagnostica** per quelle che rispondono senza portare niente. Un numero
      che non corrisponde all'elenco è il sintomo di un filtro applicato a una
      sola delle due query: la sezione e il suo contatore devono nascere dalla
      **stessa** query (è così che un coupon scaduto sparisce dall'elenco e dal
      totale nello stesso istante).

Quando una casella non torna, la causa è quasi sempre una di queste: la fonte ha
cambiato URL (404), il pattern di una sitemap è largo o stretto (leggi i motivi
degli scarti), oppure manca la credenziale della raccolta esterna (`Variabili
d'ambiente mancanti`, `D1 API 401/403`). Un cambiamento di **configurazione** non
richiede migrazioni; un cambiamento di **schema** sì, e le righe di `ALTER TABLE`
da eseguire — **prima** di pubblicare il codice che legge la colonna nuova —
stanno in [src/db/schema.sql](src/db/schema.sql).

Nota su `robots.txt`: viene rispettato per le fonti HTML e sitemap; i feed
RSS/Atom e Google News sono endpoint di sindacazione pubblicati per il consumo
automatico, quindi non vengono bloccati da robots (decisione documentata in
`src/ingest/index.ts`). Frequenze basse, User-Agent identificabile.

## 9. Budget gratuito e la CPU misurata

| Risorsa | Uso previsto | Limite Free |
|---|---|---|
| Cron Worker | ~98 esecuzioni/giorno | 5 trigger per account |
| CPU Worker | < 1 ms per tick quando la raccolta è su Actions (nessuna rete) | **10 ms per invocazione** |
| GitHub Actions | 48 giri/giorno · ~1.440 minuti/mese | 2.000 minuti/mese (repo privati) |
| Richieste Worker | ~100/giorno | 100.000/giorno |
| D1 | qualche centinaio di righe/giorno | 5M righe lette · 100k scritte |
| Workers AI | ≤ 40 chiamate/giorno | 10.000 Neurons/giorno (solo nel Worker, che non raccoglie) |
| Telegram | 2 digest + pochi avvisi | gratuito |

La raccolta sulle Actions ha un tetto di CPU suo (`ACTIONS_CPU_BUDGET_MS` nello
script): è altissimo apposta, perché lì il limite di 10 ms non esiste. Le misure
qui sotto restano la documentazione del percorso dentro il Worker (e il motivo
per cui la raccolta è uscita da lì).

### La ricerca del regolamento costa richieste, non CPU

Leggere la pagina di un concorso per trovarci il bando (sezione 5) è **una
richiesta HTTP in più per concorso nuovo**: l'attesa non è CPU, e la scansione
del testo sì ma pesa meno di un item qualsiasi. I tetti, tutti dichiarati:

| Tetto | Valore | Dove |
|---|---|---|
| Ricerche per giro | 100 | `MAX_RULES_LOOKUPS_PER_RUN` in [src/config/sources.ts](src/config/sources.ts) |
| Tempo di parete per la ricerca, nel Worker | 8 s | `RULES_LOOKUP_BUDGET_MS` in [src/pipeline.ts](src/pipeline.ts) |
| Tempo di parete per la ricerca, su Actions | 120 s | `ACTIONS_RULES_LOOKUP_MS` in [scripts/ingest.ts](scripts/ingest.ts) |
| Tentativi per pagina | 1 (nessun retry) | `regulationUrlFromPage` |
| Chi si legge | solo concorsi **nuovi**; mai coupon o articoli | `regolamentoPer`, in [src/pipeline.ts](src/pipeline.ts) |
| Prima di leggere | robots.txt (in cache 24 h in D1) | `robotsAllows`, in [src/ingest/index.ts](src/ingest/index.ts) |

Ultima misura con le pagine vere (7 fonti, 16/10/2026): 83 concorsi nuovi → 83
pagine lette, **73 bandi trovati**, in ~1 secondo di media per pagina. In regime le
fonti portano pochi concorsi nuovi per volta, quindi l'extra è di poche richieste
per giro; la prima raccolta è l'unica che ne fa tante, ed è il motivo per cui il
tetto sulle ricerche è alto. Quello che resta senza bando lo prende
`npm run rules -- --apply` (sezione 11).

### I 10 ms di CPU reggono il parsing dei feed?

Il parsing da solo sì: una fonte intera costa 0,3-1,4 ms. A sfondare i 10 ms è il
lavoro per **item** (preparazione + decisione del duplicato + arricchimento),
0,24-0,37 ms per item: 45 item in un tick fanno 9-13 ms. Due modi per misurarlo,
entrambi ripetibili:

```bash
npm run bench:cpu                                       # su Node, fonti vere
curl "http://127.0.0.1:8788/bench?secret=WEBHOOK_SECRET&fonti=8"   # dentro workerd
```

Ultima misura su 6-8 fonti reali (16/10/2026):

| Voce | Node | workerd (runtime del deploy) |
|---|---|---|
| parsing di una fonte (12-79 KB · 10-25 item) | 0,36-0,75 ms | 0-1 ms |
| costo per item (preparazione + dedup + arricchimento) | 0,24-0,31 ms | 0,26-0,37 ms |
| tick con **1 fonte piena**, tutti item nuovi | 3,8-4,7 ms | 4,5-5,5 ms |
| tick con **2 fonti piene** | 7,3-9,1 ms | 9-11 ms → sul limite |
| tick a regime, 4 fonti (304 o duplicati) | — | 1-4 ms |

Quindi il tetto non è sul numero di fonti: è sugli **item nuovi lavorati in una
invocazione**. Una fonte da 15-20 item nuovi entra nel budget; due no, e in
workerd due fonti piene arrivano a 9-11 ms, cioè sul filo dei 10 ms (errore 1102
oltre).

Come è tenuto sotto controllo:

- `CPU_BUDGET_MS = 6` è il limitatore vero: la pipeline cronometra parsing,
  preparazione, decisione del duplicato e arricchimento, e quando supera il
  budget smette di leggere item e rimanda il resto al giro dopo, con una
  garanzia: il **primo item di ogni fonte letta si lavora sempre**, così una
  fonte più pesante del budget non viene scaricata a vuoto a ogni giro. Verificato
  sul cron vero in workerd: tick a freddo con una fonte ricca = 7 ms contati, coda
  rimandata, invocazione viva (nessun 1102).
- `MAX_SOURCES_PER_RUN = 4` è solo un tetto di sicurezza. Un feed invariato
  risponde 304 e costa ~0,05 ms, quindi conviene poter controllare più fonti per
  tick e spendere la CPU dove serve invece di contingentare le fonti.
- i tetti per fonte (15 item per i feed, 20 per le sitemap) impediscono a una
  singola fonte di sfondare da sola;
- il margine 6 su 10 esiste perché il conteggio **non** copre la decodifica del
  corpo delle risposte né l'idratazione delle righe D1, e perché la prima
  invocazione dopo un deploy paga la compilazione del codice: il bench scalda
  prima di misurare, la produzione no.

### Le alternative

- **Workers Paid, 5 $/mese**: 30 secondi di CPU per invocazione (e 30M
  CPU-ms/mese): si potrebbe rimettere la raccolta nel Worker
  (`jobFor` e il cron da 15 minuti), alzare `CPU_BUDGET_MS` a qualche secondo e
  usare Workers AI per arricchire i casi dubbi. Ma non risolve **il problema
  vero**: le fonti che rispondono 403/503 alla rete di Cloudflare lo farebbero
  anche con il piano a pagamento. Per quello serve un IP che le fonti accettino.
- **Raccolta su GitHub Actions** (quella implementata): nessun limite di CPU,
  tutte le fonti a ogni giro, IP che le fonti accettano. Il prezzo è un secondo
  sistema da mantenere e i minuti Actions (sezione 4).
- **Scegliere le fonti**: con la raccolta su Actions non c'è più un tetto, quindi
  disattiva solo ciò che non ti interessa (`enabled: false`) o allunga la
  `cadenceMin` di quelle pigre; il tetto per fonte resta utile per non farsi
  sommergere da un singolo sito (`maxItems`).

**Non verificato**: la contabilità CPU di Cloudflare stessa sul Worker
pubblicato. Le misure qui sopra sono cronometro interno, dentro il runtime vero;
per leggere il numero della piattaforma serve `npx wrangler tail` su un deploy.

## 10. Diagnostica

```bash
curl "https://<worker>/health?secret=WEBHOOK_SECRET"   # esecuzioni e stato fonti
npm run dry-run                                        # cosa verrebbe inviato, senza inviare
npm run ingest                                         # raccolta vera, come su Actions
npm run prune                                          # cosa non è più un concorso attivo (elenco)
npm run prune -- --apply                               # e lo toglie dall'archivio
npm run checklist                                      # le quattro caselle di chiusura, con l'esito di D1
npm run checklist -- --fonte <id>                      # ...e per una fonte sola, tipi compresi
npm run tags                                           # tag di contenuto mancanti (elenco)
npm run tags -- --apply                                # e li aggiunge (solo aggiunta)
npm test                                               # 642 test
npm run typecheck
```

In chat: 📡 **Fonti** per lo stato di ogni fonte — ora, codice HTTP e item
letti nell'ultimo tentativo — e delle ultime raccolte, 🧾 **Log delle raccolte**
(solo admin, da 📡 Fonti o con `/log`) per il racconto **intero** di un lancio,
fonte per fonte, 🌡 **Diagnostica** (o `/diagnostica`) per sapere quali fonti
**non portano concorsi** o falliscono, con il contributo di ognuna letto
dall'archivio, ⚙️ **Impostazioni** per soglia, silenzio e digest (a cursori: vedi
la sezione 5), 🎛 **Cosa vedi** per i filtri personali. Le stesse informazioni per
fonte stanno in `/health`, nei campi `lastStatus` / `lastError` / `lastItems`.
La tabella `runs` in D1 conserva la nota e il log di ogni esecuzione: quelle con
`trigger = actions` sono la raccolta su GitHub, le altre i tick del Worker, e il
log (`log`) ce l'hanno solo le raccolte — i tick e i digest lo lasciano vuoto, ed
è per questo che 🧾 Log delle raccolte è l'elenco dei lanci.

## 11. Limiti noti

- **Il cancello di freschezza privilegia la precisione.** Un concorso vivo il cui
  URL non contiene nessuna parola di concorso, senza testo e senza data, resta
  fuori: è il prezzo per non riempire il digest di pagine di catalogo (un caso
  vero: le promozioni Ferrero chiamate `panenutellaottobre2026`).
- **Anche la divisione concorsi/news è una stima fatta dall'URL.** Un articolo la
  cui pagina non ha segnali da contenitore (titolo che promette un elenco, URL di
  categoria, permalink con la data, fonte di cronaca) resta tra i concorsi, e
  viceversa un concorso pubblicato sotto una sezione "news" del sito del brand
  resta un concorso — è il caso voluto, non un errore. Nel dubbio il codice
  preferisce **concorso**, perché nascondere un concorso vero costa più di un link
  in più da scartare. L'unico modo per non sbagliare mai è leggere la pagina, e
  ogni item letto costa CPU sui 10 ms del piano Free.
- **La consegna Telegram reale va ancora vista una volta a bot avviato**: il
  percorso di invio è coperto dai test con client finto
  ([test/telegram.test.ts](test/telegram.test.ts)) e il resto del Worker è stato
  eseguito davvero in workerd con D1 locale, ma il primo messaggio vero lo
  produce solo una `/start` dall'account.
- **Actions non è un cron esatto**: i giri programmati possono partire con
  qualche minuto di ritardo nei momenti di carico, e GitHub **disattiva** i
  workflow programmati di un repository senza attività da 60 giorni (basta
  riattivarli dal pulsante *Enable workflow*). Per un radar di concorsi va bene;
  se ti serve puntualità, l'alternativa è Workers Paid con la raccolta dentro il
  Worker.
- **Il log di una raccolta lo scrive la raccolta**, quindi per vederlo arrivare
  serve che quel codice sia **su GitHub**: un deploy del Worker non aggiorna
  `npm run ingest`, ed è il runner a sapere come sono andate le fonti (i suoi log
  sono la ragione per cui questo racconto esiste). Finché il codice su GitHub è
  vecchio, i giri nuovi non hanno un log — e in 🧾 Log delle raccolte resta
  l'ultimo che c'è, non una riga vuota. I tick e la raccolta di riserva girano
  invece dentro il Worker, quindi il loro log arriva con il **deploy**. Le colonne
  dell'ultimo tentativo le scrivono entrambi: appena un tick gira, 📡 Fonti ha i
  codici HTTP di tutte le fonti che la rete di Cloudflare raggiunge. La lettura
  dalla chat e il testo del log sono coperti dai test
  ([test/report.test.ts](test/report.test.ts), [test/telegram.test.ts](test/telegram.test.ts)).
- **La raccolta dipende dai tre secret su GitHub**: senza, il job fallisce subito
  e per due ore il radar resta completamente fermo; poi il Worker riparte con la
  raccolta di riserva (poche fonti da qui, contro quasi tutte da Actions: la rete
  di Cloudflare è bloccata da alcuni siti). La riserva però non affama più nessuna
  fonte: a ogni tick parte dalla più trascurata fra **tutte** quelle abilitate e
  ne mette in coda dodici, così un giro che brucia i primi tentativi su un 403
  continua invece di fermarsi lì — prima erano quattro fonti dello slot del
  quarto d'ora e basta. Dopo tre
  ore di silenzio arriva il promemoria in chat all'admin, quindi il guasto non
  può più passare inosservato per giorni. Il limite che resta: il controllo gira
  **dentro** il tick del Worker, quindi se è il Worker stesso a fermarsi (deploy
  rotto, cron disattivato) non lo dice nessuno — per quello serve un battito
  esterno, un servizio di uptime che chiami `/health` ogni ora.
- **Google News** restituisce URL di redirect `news.google.com/rss/articles/...`:
  funzionano ma risultano meno leggibili in anteprima.
- **Concorsi fisici/cartacei** restano invisibili se nessuno li pubblica online;
  la copertura reale è "aggregatori + brand mappati". Il registro ufficiale
  MIMIT/PREMA **non è pubblico** (richiede SPID/CNS), quindi nessun bot può
  leggerlo.
- **Il giro dei coupon è fatto di ciò che viene pubblicato, non di tutto ciò
  che è risparmiabile.** Un buono che vive solo dentro l'app o sulla carta
  fedeltà di un'insegna (Conad, Esselunga, Acqua & Sapone) non è leggibile da
  nessuna parte: entra in 💶 soltanto quando una delle fonti monitorate lo
  racconta. Gli aggregatori di codici sconto (Topnegozi, Widilo,
  CodiceRisparmio, DoveConviene, Tigotà) restano fuori per il motivo opposto: le
  loro pagine sono il catalogo dei negozi, non le offerte (sezione 8).
- **Un coupon vive sessanta giorni dalla pubblicazione** se non dichiara una
  scadenza: un buono stagionale ancora spendibile dopo due mesi sparisce
  dall'elenco, e resta solo nello storico con lo stato *chiuso* (`npm run prune`
  non lo cancella, perché non è un falso positivo: se ne occupa il cron). È la scommessa
  opposta a quella dei concorsi — lì una coda in più costa meno di una riga
  persa, qui una coda di offerte morte rende la sezione inutile. E le offerte
  **non producono notifiche**, per scelta: quando serve un buono lo decidi tu.
  Senza data di pubblicazione il coupon non si giudica e resta.
- Promo ibride (cashback con buoni) possono passare il filtro pertinenza.
- Il digest delle 06:05/17:05 UTC slitta di un'ora tra ora solare e legale: la
  finestra lo tollera, ma se vuoi orari fissi cambia i cron in `wrangler.toml`.
- Il codice gira senza build anche su Node (type-stripping): evita `enum`,
  `namespace` e le "parameter properties" di TypeScript, non supportate.
- **Tutto ciò che è esportato da `src/index.ts` diventa un entry point** del
  Worker: costanti e helper di schedulazione vivono in
  [src/schedule.ts](src/schedule.ts), altrimenti workerd non avvia.
- **La schermata in chat è un solo messaggio per chat**, e il suo id sta nella
  tabella `ui` di D1, insieme all'ora dell'ultima interazione (`updated_at`).
  Conseguenze pratiche: dopo l'aggiornamento serve `npm run db:init` (crea la
  tabella, è idempotente); se cancelli a mano quel messaggio, o se tocchi un
  bottone dopo sei ore di silenzio, il bot ne manda uno nuovo al posto di
  modificarne uno che potresti non avere più davanti; aprendo il bot da due
  dispositivi con lo stesso account la schermata è la stessa, perché è la stessa
  chat.
- **Aggiornando un archivio già esistente non serve più una riga di SQL a mano.**
  `npm run db:sync` — e il workflow `Database` a ogni push — crea tabelle e indici
  mancanti e aggiunge le colonne che il codice si aspetta: la colonna `kind`
  (concorso, offerta o articolo), per esempio, nasce con `ALTER TABLE items ADD
  COLUMN kind TEXT NOT NULL DEFAULT 'contest';`, che è quello che il comando fa da
  sé quando la trova assente, senza che nessuno lo ricordi prima del deploy. Le righe già dentro diventano concorsi,
  che è il valore giusto per un archivio nato prima della divisione. Il valore
  `coupon` invece **non chiede nessun `ALTER`**: è un valore nuovo di una colonna
  che c'è già, quindi chi ha già la `kind` è a posto. Per il resto, la sezione
  coupon non porta tabelle nuove: le sei fonti si portano in D1 con `npm run
  db:seed` (le fonti si seminano, non si alterano).
- **La diagnostica delle fonti**: le colonne `last_status`, `last_error` e
  `last_items` di `sources` le aggiunge `npm run db:sync` (in produzione ci sono
  dal 16/10/2026). Su un database non ancora migrato la schermata
  legge `null` e `0` — "non lo so" — invece di inventare un successo, e per una
  fonte riprovata prima della migrazione scrive `ok, codice non registrato`
  invece di uno `0 item` che sarebbe una misura inventata: ogni fonte torna alla
  riga completa al primo tentativo successivo.
- **I log delle raccolte**: la colonna `log` di `runs` la aggiunge `npm run
  db:sync`. La raccolta **inserisce** quella colonna, quindi su un database non
  migrato ogni lancio nuovo fallirebbe: è il motivo per cui non basta "il codice
  legge `null`" e per cui l'allineamento è automatico. Le righe scritte prima
  restano senza log (`null`, che significa "questo giro non ha un racconto", non
  "racconto vuoto") e in 🧾 Log delle raccolte non compaiono.
- **I filtri personali**: la colonna `filters` di `prefs` la aggiunge `npm run
  db:sync` (in produzione dal 16/10/2026). Il valore `{}` significa "vedi tutto":
  chi non ha mai aperto 🎛 Cosa vedi continua a vedere l'archivio intero.
- **La marca dei concorsi**: la colonna `brand` di `items` e il suo indice li
  crea `npm run db:sync` (in produzione dal 16/10/2026). Un database non ancora migrato risponde `null` — "marca non
  riconosciuta" — invece di rompere la lettura, e le righe già in archivio si
  riempiono con `npm run brands -- --apply`.
- **Il regolamento dei concorsi**: la colonna `rules_url` di `items` la aggiunge
  `npm run db:sync` — la raccolta **inserisce** quella colonna, quindi su un
  database non migrato ogni item nuovo fallirebbe. Un database
  migrato e uno no si comportano diversamente solo in lettura, e in modo sicuro:
  senza la colonna la chat non trova nessun bando salvato e ricade sul testo
dell'item, quindi il bottone 📄 Regolamento resta quello di prima. Le righe già in
  archivio (e la coda di un giro affollato) si riempiono con `npm run rules --
  --apply`, che rispetta robots.txt come la raccolta, non sovrascrive un bando già
  salvato e in mancanza di `--apply` si limita a elencare quello che farebbe.
- **Il bando si trova sulla pagina, quindi può non esserci**: se il regolamento è
dietro un pulsante JavaScript, dentro un form di iscrizione o in un PDF caricato
dopo la registrazione, il link non c'è nell'HTML e il bottone non compare — meglio
  niente che un link sbagliato. Misurato: **10 concorsi su 83** senza bando, tutti
  di promo che il regolamento non lo pubblicano affatto.
- **La tabella `sightings` (vantaggio di tempistica) è nata con `npm run db:init`
  il 16/10/2026**, quindi in produzione c'è. Su un database nuovo la crea
  `npm run db:sync` insieme alle altre: è una `CREATE TABLE IF NOT EXISTS`, non
  serve nessun `ALTER`. La pipeline registra la vista in un blocco che non può far
  fallire l'ingestione, quindi anche se la tabella mancasse si perderebbe il
  numero e non il concorso — con il motivo scritto nella nota del giro.
- **La misura del vantaggio parte dal giorno in cui è nata**: `sightings` non ha
  storico, quindi i primi numeri sono pochi e vanno letti con la riga "Misuro da
  N giorni" che la schermata mostra. Tre cose la sporcano, e tutte e tre sono
  dichiarate: l'ingest fermo (una fonte che non risponde non vede niente),
  l'accensione di una fonte nuova (la prima esecuzione scarica l'arretrato e
  sembra che l'abbiamo visto prima noi), e le fonti "stampa" come Google News,
  che restano fuori dal confronto perché sono echi e non la fonte del concorso.

## 12. Mappa del progetto

```
wrangler.toml              Worker, binding D1, Workers AI, tre cron
.dev.vars.example          template delle variabili (copialo in .dev.vars)
.github/workflows/
  ingest.yml               raccolta ogni 30 minuti su GitHub Actions
src/
  index.ts                 entry point: webhook, /setup, /health, /bench, scheduled()
  schedule.ts              cron → digest oppure avvisi e pulizia, finestra digest
  telegram/screens.ts      intenti e schermate del bot (funzioni pure)
  pipeline.ts              scelta delle fonti, deduplica, arricchimento, punteggio
  dedupe.ts                preparazione item e decisione di duplicato
  filters.ts               i filtri di una chat: esclusioni, chiavi, etichette, query
  types.ts                 tipi condivisi
  config/sources.ts        fonti dichiarative + cap di sicurezza
  config/brands.ts         le marche seguibili e come si riconoscono
  config/env.ts            allow-list chat, variabili mancanti
  lib/text.ts              normalizzazione, URL canonico, SimHash, deduplica titoli
  lib/titles.ts            titoli leggibili (urlati, parole incollate, anno attaccato)
  lib/http.ts              fetch con ETag, retry, timeout
  lib/robots.ts            parsing e matching di robots.txt
  ingest/                  rss.ts, sitemap.ts, httplist.ts, index.ts
  enrich/                  rules.ts, score.ts, ai.ts, kind.ts (concorso, offerta o articolo), freshness.ts,
                           proof.ts (cosa conservare e quando chiedere il premio, per la scheda),
                           regulation.ts (il bando del concorso: dal testo o dalla sua pagina),
                           lead.ts (vantaggio di tempistica: canali, viste, statistiche)
  db/                      schema.sql, store.ts, d1.ts, d1-http.ts, memory.ts
  telegram/                api.ts, format.ts, keyboard.ts, screens.ts, bot.ts, digest.ts
  debug/bench.ts           misura della CPU per invocazione (Node e workerd)
scripts/
  ingest.ts                la raccolta: stessa pipeline, store su API HTTP di D1
  backfill-brands.ts       riempie la marca dei concorsi già in archivio
                           (prova a vuoto, poi --apply)
  backfill-rules.ts        cerca il regolamento dei concorsi già in archivio e di
                           quelli rimasti in coda (prova a vuoto, poi --apply)
  prune-stale.ts           toglie dall'archivio i falsi positivi (prova a vuoto,
                           poi --apply): stesso cancello della raccolta
  dry-run.ts               prova generale senza inviare nulla
  bench-cpu.ts             stessa misura su Node, con le fonti vere
  seed-sources.ts          genera l'SQL di sincronizzazione delle fonti
test/                      25 file, 493 test (vitest, nessuna rete tranne i finti)
```

Il tratto che tiene insieme tutto: **una sola copia dell'SQL**. `src/db/d1.ts`
scrive le query e le esegue su un "esecutore" astratto; il Worker gli passa il
binding D1 (`env.DB`), la raccolta su Actions gli passa l'API HTTP
(`src/db/d1-http.ts`). I due trasporti sono coperti dai test che eseguono le
query vere su SQLite ([test/d1-sqlite.test.ts](test/d1-sqlite.test.ts)) e
l'adapter HTTP con un finto API che esegue l'SQL
([test/d1-http.test.ts](test/d1-http.test.ts)).
