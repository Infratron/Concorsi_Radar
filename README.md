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
  slug — le pagine di catalogo, le tassonomie e le pagine indice. Le stesse
  regole valgono per il digest e per la pulizia dell'archivio (`npm run prune`),
  e la nota di ogni raccolta dice quanti item ha scartato e perché.
- **Concorsi e articoli sono due cose diverse, e in chat stanno in due posti.**
  Ogni item entra in archivio con un tipo (`contest` o `news`) deciso in
  [src/enrich/kind.ts](src/enrich/kind.ts) da URL, titolo e tipo di fonte: la
  sezione dei concorsi contiene **solo pagine su cui si partecipa**, mentre la
  notizia *sul* concorso, la pagina-elenco e la tassonomia finiscono in 📰 News.
  È la differenza fra aprire un link e partecipare, e aprire un pezzo che
  promette dieci concorsi e non ne fa vincere nessuno. Gli articoli non
  producono notifiche: si leggono quando si vuole. Misurato il 16/10/2026 su una
  lettura delle sole fonti di cronaca: **30 articoli e 10 concorsi** — senza la
  divisione, quei 30 finivano nella sezione dei concorsi.
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
| `CLOUDFLARE_ACCOUNT_ID` | dashboard Cloudflare: l'id dell'account è nel primo pezzo dell'URL (`dash.cloudflare.com/<ACCOUNT_ID>/...`) |
| `CLOUDFLARE_API_TOKEN` | dashboard → My Profile → API Tokens → Create Token → template **D1 / Edit**, limitato al tuo account e a questo database |
| `D1_DATABASE_ID` | lo stesso `database_id` che sta in `wrangler.toml` |

Facoltativi, per l'avviso di fonte in errore su Telegram (senza, resta solo
visibile in `/fonti`): `TELEGRAM_BOT_TOKEN` e `ADMIN_CHAT_ID`.

Con la [gh CLI](https://cli.github.com) si impostano dalla cartella del progetto
(dalla UI è identico):

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID     # incolla il valore quando lo chiede
gh secret set CLOUDFLARE_API_TOKEN
gh secret set D1_DATABASE_ID
```

Poi Actions → **Raccolta concorsi** → *Run workflow* per il primo giro: la pagina
del job mostra il riepilogo (fonti ok, item nuovi, duplicati) e i giri successivi
partono da soli. `npm run ingest` è lo stesso script da riga di comando, con le
tre variabili esportate a mano: utile per provarlo prima di affidarlo ad Actions.

Se il job diventa rosso, i log dicono quale fonte o quale credenziale non va. Un
giro in cui **nessuna** fonte risponde fa fallire il job di proposito: è la spia
di un problema vero (token scaduto, permesso D1 sbagliato, rete).

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
vecchio e ne manda uno nuovo**, mentre un tocco su un bottone modifica sul posto:
lì il messaggio è visibile per definizione, perché lo stai toccando. In entrambi i
casi in chat resta un messaggio solo.

```
📡 Concorsi Radar

[🆕 Nuovi (3)]        [📋 Oggi (12)]
[📅 7 giorni (40)]    [⏳ Scadenze (2)]
[⭐ Salvati (1)]      [📰 News (7)]
[🔍 Cerca]            [📡 Fonti]
[⚙️ Impostazioni]     [🔄 Aggiorna]
```

| Sezione | Cosa mostra |
|---|---|
| 🆕 Nuovi | quello che è arrivato **dall'ultimo controllo** (il numero è sulla voce del menù) |
| 📋 Oggi / 📅 7 giorni | l'archivio recente, ordinato per punteggio |
| ⏳ Scadenze | chi chiude entro 7 giorni e **non è già chiuso** |
| ⭐ Salvati | i concorsi che hai salvato, con la scadenza più vicina in cima |
| 📰 News | gli articoli e le pagine-elenco che parlano di concorsi: **non** sono concorsi, e il link porta al pezzo, non alla pagina ufficiale |
| 🔍 Cerca | scrivi una parola: il bot cancella il tuo messaggio e mostra i risultati (concorsi e news insieme, gli articoli marcati 📰) |
| 📡 Fonti | quali fonti rispondono, quando, e le ultime raccolte |
| ⚙️ Impostazioni | soglia degli avvisi, fascia di silenzio, orari dei digest |
| 🔄 Aggiorna | rilegge tutto e dice se è arrivato qualcosa di nuovo |

Tutte le sezioni dei concorsi mostrano **solo i concorsi**: la pagina di un
aggregatore o la notizia di un giornale non compaiono mai lì dentro. Le sezioni
che *notificano* (avvisi immediati e digest) guardano la stessa fetta, quindi un
articolo non ti sveglia per niente.

Gli elenchi sono **bottone per concorso** (`⭐85 ⏳3gg · Concorso Barilla…`):
toccandone uno si apre la scheda, e da lì `⬅️ Torna all'elenco`. Nella scheda ci
sono le decisioni ✅ Salva, 🚫 Non mi interessa, 🏆 Vinto (quella già presa resta
visibile e inerte), 🔗 Apri e 📄 Regolamento quando l'URL è nel testo.

**Salva** e **Non mi interessa** addestrano i pesi: ogni tag dei concorsi che
salvi guadagna un punto, quelli che ignori ne perdono uno (clamp ±5 per tag),
quindi i punteggi si spostano verso i tuoi gusti. Le decisioni sono **per
persona**: se tu ignori un concorso, alla tua amica arriva lo stesso.

**Le notifiche** (avvisi immediati e digest) sono messaggi a sé, e hanno gli stessi
bottoni: dal digest tocchi un concorso e si apre la scheda nella schermata viva.
La differenza è cosa succede dopo: il digest **resta** (è contenuto da rileggere),
mentre l'avviso immediato ha già fatto il suo lavoro appena lo usi e il bot lo
cancella, così in chat non resta niente di appeso.

Decidere due volte la stessa cosa — doppio tocco, o lo stesso concorso visto nel
digest e nella scheda — non sposta i pesi due volte.

I comandi funzionano ancora ma sono scorciatoie, non il modo normale: `/start`
(che è anche l'iscrizione, ed è l'unico pubblicato nel menù "/" di Telegram),
`/menu`, `/nuovi`, `/oggi`, `/settimana`, `/scadenze`, `/salvati`, `/news`,
`/cerca`, `/fonti`, `/impostazioni`, `/stop` e `/salva|/vinto|/ignora <id>`.

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

## 7. Punteggio e antispam

Punteggio 0-100 (`src/enrich/score.ts`), pesi trasparenti: valore del premio
(30), sforzo richiesto (20), scadenza entro 3 giorni (18) o 14 (12), freschezza
(12/6), nessun obbligo d'acquisto (10), parole chiave come *gift card* o
*in palio* (5), più bonus/malus dai tuoi feedback.

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
| Fascia di silenzio | 23:00-07:00 italiane |
| Primo giro | nessun avviso immediato |
| Notizie fuori tema | filtrate sulle fonti Google News |
| Fonte rotta | 3 errori di fila → **un solo** avviso all'admin |

## 8. Fonti monitorate

Verificate il 16/10/2026 (feed leggibili senza login): Premi e Concorsi,
Scontrino Felice (con acquisto + gratuiti), DimmiCosaCerchi, Soldissimi, Vincimi,
più sei query Google News e alcune sitemap. L'elenco completo con stato di
verifica è in [src/config/sources.ts](src/config/sources.ts).

**I brand.** Gli aggregatori non coprono i concorsi che un'azienda pubblica solo
sul proprio sito: l'unico modo è guardare le **sitemap e le pagine promozionali**
dei marchi. Le fonti qui sotto sono state provate una per una con i parser veri
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

Misura della prima raccolta completa con tutte le fonti (22 su 22, 16/10/2026):
**267 item letti, 213 nuovi, 32 duplicati, 22 fuori tema, 0 errori**, in 9 secondi.
Prima di queste fonti la stessa raccolta ne trovava 99. Il cancello di freschezza è
arrivato dopo: sulle fonti di elenco scarta la maggior parte di quello che legge
(Conad 18 su 20, Ferrero 18 su 20, Burger King 18 su 18), e i 54 falsi positivi che
erano già in archivio — tassonomie di Premi e Concorsi, catalogo Conad, kit Lavazza,
la promo Conad del 2024 — sono stati tolti con `npm run prune -- --apply`.

**Aggiungere una fonte**: aggiungi una voce in `SOURCES` (basta `id`, `name`,
`kind`, `url`, `category`, `tags`, `cadenceMin`), poi `npm run db:seed` e
`npm run deploy`. Le fonti marcate `enabled: false` sono da validare a mano
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
npm test                                               # 243 test
npm run typecheck
```

In chat: 📡 **Fonti** per lo stato di ogni fonte e delle ultime raccolte, ⚙️
**Impostazioni** per soglia, silenzio e digest.
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
- **La raccolta dipende dai tre secret su GitHub**: senza, il job fallisce subito
  e per due ore il radar resta completamente fermo; poi il Worker riparte con la
  raccolta di riserva (2 fonti su 12 da qui, contro 12 su 12 da Actions). Non è un
  caso che venga notato tardi: la nota in `/health` e i log del job lo dicono, e
  ogni raccolta riuscita riporta il `failStreak` delle fonti a zero.
- **Google News** restituisce URL di redirect `news.google.com/rss/articles/...`:
  funzionano ma risultano meno leggibili in anteprima.
- **Concorsi fisici/cartacei** restano invisibili se nessuno li pubblica online;
  la copertura reale è "aggregatori + brand mappati". Il registro ufficiale
  MIMIT/PREMA **non è pubblico** (richiede SPID/CNS), quindi nessun bot può
  leggerlo.
- OmaggioMania e scontOmaggio rispondono 403 al fetch diretto: esclusi
  (servirebbe un browser headless su un secondo host).
- Promo ibride (cashback con buoni) possono passare il filtro pertinenza.
- Il digest delle 06:05/17:05 UTC slitta di un'ora tra ora solare e legale: la
  finestra lo tollera, ma se vuoi orari fissi cambia i cron in `wrangler.toml`.
- Il codice gira senza build anche su Node (type-stripping): evita `enum`,
  `namespace` e le "parameter properties" di TypeScript, non supportate.
- **Tutto ciò che è esportato da `src/index.ts` diventa un entry point** del
  Worker: costanti e helper di schedulazione vivono in
  [src/schedule.ts](src/schedule.ts), altrimenti workerd non avvia.
- **La schermata in chat è un solo messaggio per chat**, e il suo id sta nella
  tabella `ui` di D1. Conseguenze pratiche: dopo l'aggiornamento serve `npm run
  db:init` (crea la tabella, è idempotente); se cancelli a mano quel messaggio il
  bot ne manda uno nuovo al tocco successivo, e comunque `/start` ne apre sempre
  uno fresco togliendo il precedente; aprendo il bot da due dispositivi
  con lo stesso account la schermata è la stessa, perché è la stessa chat.

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
  types.ts                 tipi condivisi
  config/sources.ts        fonti dichiarative + cap di sicurezza
  config/env.ts            allow-list chat, variabili mancanti
  lib/text.ts              normalizzazione, URL canonico, SimHash, deduplica titoli
  lib/titles.ts            titoli leggibili (urlati, parole incollate, anno attaccato)
  lib/http.ts              fetch con ETag, retry, timeout
  lib/robots.ts            parsing e matching di robots.txt
  ingest/                  rss.ts, sitemap.ts, httplist.ts, index.ts
  enrich/                  rules.ts, score.ts, ai.ts, kind.ts (concorso o articolo), freshness.ts
  db/                      schema.sql, store.ts, d1.ts, d1-http.ts, memory.ts
  telegram/                api.ts, format.ts, keyboard.ts, screens.ts, bot.ts, digest.ts
  debug/bench.ts           misura della CPU per invocazione (Node e workerd)
scripts/
  ingest.ts                la raccolta: stessa pipeline, store su API HTTP di D1
  prune-stale.ts           toglie dall'archivio i falsi positivi (prova a vuoto,
                           poi --apply): stesso cancello della raccolta
  dry-run.ts               prova generale senza inviare nulla
  bench-cpu.ts             stessa misura su Node, con le fonti vere
  seed-sources.ts          genera l'SQL di sincronizzazione delle fonti
test/                      14 file, 243 test (vitest, nessuna rete)
```

Il tratto che tiene insieme tutto: **una sola copia dell'SQL**. `src/db/d1.ts`
scrive le query e le esegue su un "esecutore" astratto; il Worker gli passa il
binding D1 (`env.DB`), la raccolta su Actions gli passa l'API HTTP
(`src/db/d1-http.ts`). I due trasporti sono coperti dai test che eseguono le
query vere su SQLite ([test/d1-sqlite.test.ts](test/d1-sqlite.test.ts)) e
l'adapter HTTP con un finto API che esegue l'SQL
([test/d1-http.test.ts](test/d1-http.test.ts)).
