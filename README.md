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
- **Le offerte hanno una sezione loro, e una vita più corta.** Un buono sconto
  non si vince, si spende: le due cose si cercano in momenti diversi, quindi
  💶 Coupon e rimborsi è una sezione a sé (sei fonti dichiarano la categoria
  `coupon` in [src/config/sources.ts](src/config/sources.ts)) e le offerte **non
  producono notifiche** — avvisi e digest guardano i soli concorsi, perché un
  coupon da stampare non è mai urgente come una scadenza. La promozione che
  **annuncia anche un premio** resta invece un concorso, e lo fa in modo
  dichiarato: "Cashback Fabuloso: 5 € di rimborso **e vinci** una lavatrice" sta
  fra i concorsi, perché nasconderlo costerebbe più di un coupon di troppo (la
  regola sta in [src/enrich/kind.ts](src/enrich/kind.ts)).
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
npm run db:init                   # crea le tabelle
npm run db:seed                   # sincronizza le fonti dal file di configurazione
                                  # (rieseguilo a ogni aggiornamento che ne aggiunge:
                                  #  es. i sei feed di coupon e rimborsi)

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

Facoltativi, per gli avvisi e per il **report delle fonti** in chat (senza, tutto
resta visibile in 📡 Fonti e in `/health`): `TELEGRAM_BOT_TOKEN` e `ADMIN_CHAT_ID`.

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
| Build command | `npm ci && npm run typecheck && npm test` |
| Deploy command | `npx wrangler deploy` |
| Preview builds | **disattivate** (vedi sotto) |

Il *build command* è la rete di sicurezza: se il typecheck o uno dei 243 test
fallisce, la build si ferma e **il deploy non parte**. `npm ci` serve a rendere
l'installazione riproducibile dal `package-lock.json`.

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

Cosa **non** fa il deploy: le modifiche allo schema del database. Se aggiungi
una tabella, esegui `npm run db:init` a mano (è idempotente, usa
`CREATE TABLE IF NOT EXISTS`) oppure passa alle migrazioni tracciate di D1
(`wrangler d1 migrations`).

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
[⭐ Watchlist (1)]    [📰 News (7)]
[🔍 Cerca]            [🗂 Storico]
[💶 Coupon e rimborsi (67)]
[🏷 Preferiti per marca (4)] [🎛 Cosa vedi]
[📡 Fonti]            [⚙️ Impostazioni]
[🔄 Aggiorna]
```

| Sezione | Cosa mostra |
|---|---|
| 🆕 Nuovi | quello che è arrivato **dall'ultimo controllo** (il numero è sulla voce del menù) |
| 📋 Oggi / 📅 7 giorni | l'archivio recente, ordinato per punteggio |
| ⏳ Scadenze | chi chiude entro 7 giorni e **non è già chiuso** |
| ⭐ Watchlist | i concorsi che hai salvato, **ordinati per scadenza** (chi chiude prima sta in cima) e con il promemoria a 3 giorni e 1 giorno dalla chiusura |
| 📰 News | gli articoli e le pagine-elenco che parlano di concorsi: **non** sono concorsi, e il link porta al pezzo, non alla pagina ufficiale |
| 💶 Coupon e rimborsi | i buoni sconto, i rimborsi e le operazioni a cashback da spendere al negozio o online: **non** sono concorsi e **non** producono notifiche (qui sotto) |
| 🗂 Storico | cosa è successo a quello che hai visto: 🏆 vinti, ⌛ chiusi (chi ha chiuso per ultimo in cima) e 🚫 scartati, che da lì puoi riprendere |
| 🔍 Cerca | scrivi una parola: il bot cancella il tuo messaggio e mostra i risultati (concorsi e news insieme, gli articoli marcati 📰) |
| 🏷 Preferiti per marca | le marche che segui: filtrano i concorsi, valgono **10 punti in più** e hanno una sezione loro (qui sotto) |
| 🎛 Cosa vedi | i tuoi filtri: quali tipi di concorso, quali categorie di fonti e quali fonti vuoi vedere (qui sotto) |
| 📡 Fonti | quali fonti rispondono: ora, codice HTTP e item dell'ultimo tentativo, più le ultime raccolte (e la porta a 🌡 Diagnostica) |
| 🏁 Vantaggio | `/vantaggio`: di quanto arriviamo prima degli aggregatori, e quanto spesso non arriviamo affatto |
| ⚙️ Impostazioni | soglia degli avvisi, fascia di silenzio e orari dei digest, regolabili di fino, più la porta ai filtri |
| 🔄 Aggiorna | rilegge tutto e dice se è arrivato qualcosa di nuovo |

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
guardare questo concorso adesso" e su un buono sconto sarebbe inventato).Nella scheda ci sono le decisioni ⭐ Watchlist, 🚫 Non mi interessa, 🏆
Vinto (quella già presa resta visibile e inerte), 🔗 Apri e 📄 Regolamento.

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

Ogni elenco è **a pagine di sei**, con `⬅️ Prec` / `Succ ➡️` e il numero di
pagina in mezzo: la pagina che vedi la legge il database con LIMIT/OFFSET, quindi
si sfoglia tutto l'archivio, non solo le prime righe.

Sotto l'elenco dei concorsi c'è **una riga sola** per le stelle — `⭐ Tutte`,
`⭐ 70+`, `⭐ 80+` — con il pallino sulla soglia attiva: serve a tenere la testa
della classifica senza aprire nessun menù, e non compare dove non ha senso (📰
News, ⭐ Watchlist, 🗂 Storico, 🔍 Cerca). Se un elenco resta vuoto con i filtri
accesi il bot lo dice (`🎛 Hai N filtri attivi`) e mette lì il bottone per
allargare: "non c'è niente" e "hai spento tu le fonti" sono due cose diverse.

### 🎛 Cosa vedi: i filtri sono tuoi

Il bot è condiviso, il feed no: **ogni chat ha i suoi filtri**, e quello che
spegni tu non cambia niente per l'altra persona (stessa regola delle consegne e
dei pesi). I filtri stanno in `prefs.filters` in D1, una riga JSON per chat.

Dentro 🎛 **Cosa vedi** ci sono tre gruppi di interruttori — ✅ mostra, 🚫
nasconde:

- **tipi di concorso**: raccolte punti, premio certo, gift card, viaggi,
elettronica, casa, food, moda, bambini (sono i tag che le regole assegnano
leggendo premio e testo);
- **categorie di fonti**: online, punto vendita, scontrino, gift card — spegnere
una categoria spegne tutte le fonti che la dichiarano;
- **⭐ stelle minime**: `Tutte`, `70+` o `80+`. È lo stesso filtro della riga in
fondo agli elenchi, e come quello vale anche per le notifiche;
- **🎁 solo senza acquisto**, che lascia fuori chi chiede uno scontrino, un codice
sulla confezione o un minimo di spesa;
- **📡 Scegli le fonti**: l'elenco delle fonti accese, una per riga e a pagine,
per spegnere quella singola che ti manda rumore.

Sono **esclusioni, non inclusioni**: una fonte o un tipo nuovi si vedono finché
non li spegni, quindi un archivio che cresce non ti resta invisibile. I filtri
valgono nelle sezioni che *suggeriscono* cosa guardare (🆕 Nuovi, 📋 Oggi, 📅 7
giorni, ⏳ Scadenze, 📰 News, ⌛ Scaduti), nei **numeri del menù** (che contano
quello che vedi, con la riga `🎛 Filtri tuoi: 12 di 40 concorsi` a dire quanto
stai lasciando fuori) e nelle **notifiche** — digest e avvisi immediati. Non
valgono invece su ⭐ Watchlist, 🗂 Storico e 🔍 Cerca: lì hai scelto tu cosa
guardare, e un concorso salvato non deve sparire perché hai spento la sua fonte.

Misurato il 16/10/2026 con la chat vera sopra uno store D1 su SQLite: spegnendo
le raccolte punti e la categoria scontrino, l'elenco passa da 3 a 2 concorsi, il
digest di quella chat cambia e quello dell'altra no, e `♻️ Vedi di nuovo tutto`
rimette l'archivio intero (31 controlli su 31).

### 🏷 Preferiti per marca: le marche che segui

Ferrero, Coca-Cola, Conad: le marche che ti interessano valgono più delle altre, e
la sezione **🏷 Preferiti per marca** è dove si dicono. Ogni voce è un
interruttore (`✅` la segui, `⬜️` no) con **quanti concorsi ha in archivio**: le
marche che hanno qualcosa stanno in cima, quelle che non ne hanno in fondo, così
il registro si scorre a pagine di dodici senza cercare niente.

Accendere una marca fa **tre** cose:

1. i suoi concorsi valgono **10 punti in più** (e la scala è dichiarata: è più di
tutti i segnali di qualità — un premio certo vale 5 — e meno dell'urgenza di una
scadenza a tre giorni);
2. i concorsi **già in archivio** vengono ripunteggiati subito, con lo stesso
conto dell'ingestione: la marca che segui oggi non aspetta la prossima raccolta;
3. nasce la sezione **📋 I loro concorsi**, che mostra solo quello.

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

**⭐ Watchlist** è il posto dove tieni i concorsi che vuoi fare davvero. Due cose
la rendono utile: l'ordine per scadenza (chi chiude prima è in cima) e il
promemoria automatico **tre giorni e un giorno prima della chiusura** — un
messaggio con il link, così non si perde proprio quello che tenevi d'occhio. Chi
non ha una scadenza resta in watchlist senza promemoria.

**Watchlist** e **Non mi interessa** addestrano i pesi: ogni tag dei concorsi che
salvi guadagna un punto, quelli che ignori ne perdono uno (clamp ±5 per tag),
quindi i punteggi si spostano verso i tuoi gusti. Le decisioni sono **per
persona**: se tu ignori un concorso, alla tua amica arriva lo stesso.

**Le notifiche** (avvisi immediati, promemoria della watchlist e digest) sono
messaggi a sé, e hanno gli stessi bottoni: dal digest tocchi un concorso e si
apre la scheda nella schermata viva.
La differenza è cosa succede dopo: il digest **resta** (è contenuto da rileggere),
mentre l'avviso immediato ha già fatto il suo lavoro appena lo usi e il bot lo
cancella, così in chat non resta niente di appeso.

Decidere due volte la stessa cosa — doppio tocco, o lo stesso concorso visto nel
digest e nella scheda — non sposta i pesi due volte.

I comandi funzionano ancora ma sono scorciatoie, non il modo normale: `/start`
(che è anche l'iscrizione, ed è l'unico pubblicato nel menù "/" di Telegram),
`/menu`, `/nuovi`, `/oggi`, `/settimana`, `/scadenze`, `/salvati` (o
`/watchlist`), `/news`, `/coupon`, `/storico`, `/vinti`, `/scaduti`, `/cerca`, `/fonti`,
`/diagnostica`, `/vantaggio`, `/impostazioni`, `/stop` e
`/salva|/vinto|/ignora <id>`.

### 💶 Coupon e rimborsi: si spende meno, non si vince

Un buono sconto da stampare, un rimborso con lo scontrino, un cashback che ti
riaccredita metà della spesa: sono la cosa che si cerca *quando si deve
comprare*, e in mezzo ai concorsi sarebbero rumore. La sezione è una riga sola
nel menù — `💶 Coupon e rimborsi (67)` — e dentro c'è solo questo.

Tre differenze dalle altre sezioni, tutte volute:

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
una risposta: siamo noi a non poterla leggere. Sono le stesse parole nel report,
nella schermata e in `/health` (`lastStatus`, `lastError`, `lastItems` per fonte),
perché il vocabolario degli esiti sta in un posto solo
([src/telegram/report.ts](src/telegram/report.ts)).

**Il report fonte per fonte** arriva in chat all'admin nelle **prime tre raccolte**
con la diagnostica accesa — con l'esito di ognuna e i problemi in cima — e in ogni
raccolta lanciata **a mano** dal pulsante *Run workflow*: lì la domanda è di un
umano ("ho cambiato una fonte, come è andata?"), e a una domanda si risponde
sempre. Negli altri giri non si manda niente: lo stato resta in 📡 Fonti, che non
fa rumore. Quale raccolta ha già ricevuto il report lo dice la nota
dell'esecuzione (`diagnostica: inviata`), e il segno si scrive **solo** se il
messaggio è partito davvero, così un invio fallito si ritenta al giro dopo invece
di essere dato per fatto.

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
[src/config/sources.ts](src/config/sources.ts) e si lancia `npm run db:seed`; per
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
digest, promemoria della watchlist e promemoria della raccolta ferma — e gli item
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
una marca che segui** (🏷 Preferiti per marca).

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
| Fascia di silenzio | 23:00-07:00 italiane (è il default: si cambia da ⚙️ Impostazioni) |
| Primo giro | nessun avviso immediato |
| Notizie fuori tema | filtrate sulle fonti Google News |
| Fonte rotta | 3 errori di fila → **un solo** avviso all'admin |

## 8. Fonti monitorate

Verificate il 16/10/2026 (feed leggibili senza login): Premi e Concorsi,
Scontrino Felice (**quattro** sezioni: con acquisto, gratuiti, premio certo,
raccolte punti), DimmiCosaCerchi, Soldissimi, Vincimi, più sei query Google News
e alcune sitemap — e, dallo stesso giorno, **sei feed di coupon e rimborsi** (la
ricognizione e i motivi delle esclusioni stanno qui sotto). L'elenco completo con
stato di verifica è in
[src/config/sources.ts](src/config/sources.ts).

**Scontrino Felice** è la fonte più ricca, e la sua sitemap e i suoi feed
pubblicano gli **stessi URL**: la deduplica li tiene come una riga sola e vince il
nome più completo (vedi la sezione 6). Misurato il 16/10/2026 sulle sue sole
cinque fonti: **87 concorsi, 87 URL distinti, zero titoli mozzi**, e al giro
successivo 0 nuovi su 20 riletti. Si legge con i suoi feed e non dalla sitemap
perché i feed portano il titolo vero ("Concorso Lievital: vinci Forni e
Scaldavivande") mentre la sitemap porta lo slug ("Concorso Lievital"): 25 item per
sezione, che è tutto quello che il sito tiene in vetrina.

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
| Burger King · regolamenti | sitemap | 0: le due pagine che ha sono del 2024 e 2025 |
| Eni Più Insieme · concorsi | sitemap | 6 su 6 (i concorsi hanno nomi di premio, la sezione `/concorsi-premi/` è il segnale) |
| PAYBACK · regolamenti | sitemap | 0: 5 regolamenti dal 2018 al 2021 |
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
raccontano.

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

Esclusi con il motivo, perché la ricognizione serve a non riprovarli:
**OmaggioMania** risponde 200 ma il suo feed è il blog generalista del sito
(omaggi con acquisto, volantini, concorsi) e le offerte da spendere sono la
minoranza — 10 item letti, e quel poco di buono lo portano già le altre tre;
**SpesaBack** pubblica la home, la guida e il "come funziona", non le offerte.

Misura della prima raccolta completa con tutte le fonti (22 su 22, 16/10/2026):
**267 item letti, 213 nuovi, 32 duplicati, 22 fuori tema, 0 errori**, in 9 secondi.
Prima di queste fonti la stessa raccolta ne trovava 99. Il cancello di freschezza è
arrivato dopo: sulle fonti di elenco scarta la maggior parte di quello che legge
(Conad 18 su 20, Ferrero 18 su 20, Burger King 18 su 18), e i 54 falsi positivi che
erano già in archivio — tassonomie di Premi e Concorsi, catalogo Conad, kit Lavazza,
la promo Conad del 2024 — sono stati tolti con `npm run prune -- --apply`.

**Aggiungere una fonte**: aggiungi una voce in `SOURCES` (basta `id`, `name`,
`kind`, `url`, `category`, `tags`, `cadenceMin`), poi `npm run db:seed` e
`npm run deploy`. Per una fonte di **offerte** basta dichiarare
`category: "coupon"`: la classificazione la legge e i suoi item finiscono in
💶 Coupon e rimborsi invece che fra i concorsi, senza altra configurazione. Le
fonti marcate `enabled: false` sono da validare a mano
(i selettori/pattern non sono ancora verificati sul markup reale).

**Rimuoverne una**: imposta `enabled: false` e riesegui il seed, oppure
disattivala dal database (lo stato in D1 comanda a runtime).

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
npm test                                               # 449 test
npm run typecheck
```

In chat: 📡 **Fonti** per lo stato di ogni fonte — ora, codice HTTP e item
letti nell'ultimo tentativo — e delle ultime raccolte, 🌡 **Diagnostica** (o
`/diagnostica`) per sapere quali fonti **non portano concorsi** o falliscono, con
il contributo di ognuna letto dall'archivio, ⚙️ **Impostazioni** per
soglia, silenzio e digest (a cursori: vedi la sezione 5), 🎛 **Cosa vedi** per i
filtri personali. Le stesse informazioni per fonte stanno in `/health`, nei campi
`lastStatus` / `lastError` / `lastItems`.
La tabella `runs` in D1 conserva la nota di ogni esecuzione: quelle con
`trigger = actions` sono la raccolta su GitHub, le altre i tick del Worker.

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
- **Il report delle fonti gira dentro la raccolta su Actions**, quindi per
  vederlo arrivare serve che quel codice sia **su GitHub**: un deploy del Worker
  non lo aggiorna, e il report è dell'ambiente in cui la raccolta gira davvero (i
  log del runner sono la ragione per cui esiste). Le colonne dell'ultimo
  tentativo invece le scrive anche il Worker, nella raccolta di riserva: appena un
  tick gira, 📡 Fonti ha i codici HTTP di tutte le fonti che la rete di Cloudflare
  raggiunge. L'invio del messaggio è coperto dai test con il client Telegram finto
  ([test/report.test.ts](test/report.test.ts)), come le altre notifiche.
- **La raccolta dipende dai tre secret su GitHub**: senza, il job fallisce subito
  e per due ore il radar resta completamente fermo; poi il Worker riparte con la
  raccolta di riserva (2 fonti su 12 da qui, contro 12 su 12 da Actions). Dopo tre
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
- **Aggiornando un archivio già esistente serve una riga di SQL a mano.** `npm
  run db:init` usa `CREATE TABLE IF NOT EXISTS`, quindi non tocca le tabelle già
  create: la colonna `kind` (concorso, offerta o articolo) va aggiunta con
  `ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'contest';` — altrimenti
  il Worker nuovo non legge l'archivio. Le righe già dentro diventano concorsi,
  che è il valore giusto per un archivio nato prima della divisione. Il valore
  `coupon` invece **non chiede nessun `ALTER`**: è un valore nuovo di una colonna
  che c'è già, quindi chi ha già la `kind` è a posto. Per il resto, la sezione
  coupon non porta tabelle nuove: le sei fonti si portano in D1 con `npm run
  db:seed` (le fonti si seminano, non si alterano).
- **Stessa cosa per la diagnostica delle fonti**: le colonne `last_status`,
  `last_error` e `last_items` di `sources` vanno aggiunte con
  `ALTER TABLE sources ADD COLUMN last_status INTEGER;`,
  `ALTER TABLE sources ADD COLUMN last_error TEXT;` e
  `ALTER TABLE sources ADD COLUMN last_items INTEGER NOT NULL DEFAULT 0;` prima di
  pubblicare il codice che le scrive (l'`ALTER` è già stato eseguito sul database
  di produzione il 16/10/2026). Su un database non ancora migrato la schermata
  legge `null` e `0` — "non lo so" — invece di inventare un successo, e per una
  fonte riprovata prima della migrazione scrive `ok, codice non registrato`
  invece di uno `0 item` che sarebbe una misura inventata: ogni fonte torna alla
  riga completa al primo tentativo successivo.
- **Stessa cosa per i filtri personali**: la colonna `filters` di `prefs` va
  aggiunta con `ALTER TABLE prefs ADD COLUMN filters TEXT NOT NULL DEFAULT '{}';`
  prima di pubblicare il codice che la usa (l'`ALTER` è già stato eseguito sul
  database di produzione il 16/10/2026). Il valore `{}` significa "vedi tutto":
  chi non ha mai aperto 🎛 Cosa vedi continua a vedere l'archivio intero.
- **Stessa cosa per la marca dei concorsi**: la colonna `brand` di `items` va
  aggiunta con `ALTER TABLE items ADD COLUMN brand TEXT;` più
  `CREATE INDEX IF NOT EXISTS idx_items_brand ON items (brand);` prima di
  pubblicare il codice che la legge e la scrive (eseguiti in produzione il
  16/10/2026). Un database non ancora migrato risponde `null` — "marca non
  riconosciuta" — invece di rompere la lettura, e le righe già in archivio si
  riempiono con `npm run brands -- --apply`.
- **Stessa cosa per il regolamento dei concorsi**: la colonna `rules_url` di
  `items` va aggiunta con `ALTER TABLE items ADD COLUMN rules_url TEXT;` prima di
  pubblicare il codice che la scrive — la raccolta **inserisce** quella colonna,
  quindi su un database non migrato ogni item nuovo fallirebbe. Un database
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
  `db:init` insieme alle altre: è una `CREATE TABLE IF NOT EXISTS`, non serve
  nessun `ALTER`. La pipeline registra la vista in un blocco che non può far
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
