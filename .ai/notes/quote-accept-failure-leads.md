# Akceptacja oferty przez klienta kończy się błędem — tropy do weryfikacji

Status: **analiza kodu, nic jeszcze nie zmierzone na żywym środowisku.**
Data: 2026-09-19. Objaw: klient otwiera link z maila, widzi ofertę, klika „Akceptuj", dostaje błąd.

## Skąd dowody

`node_modules` nie jest zainstalowane w tej sesji, więc źródła frameworka pobrałem
z rejestru: `@open-mercato/core@0.8.0` (`curl` → `npm pack`-owy tarball), rozpakowane do
scratchpada. Wszystkie cytaty niżej pochodzą z `package/src/modules/sales/...` tej wersji —
czyli dokładnie tej, którą deklaruje `package.json`.

## Mapa ścieżki

| Krok | Plik |
|---|---|
| Wysłanie oferty | `sales/api/quotes/send/route.ts` — ustawia `status='sent'`, `sentAt`, `acceptanceToken`, `validUntil = now + validForDays`; link w mailu = `${APP_URL}/quote/<rawToken>` (`:203-204`) |
| Strona publiczna | `sales/frontend/quote/[token]/page.tsx` — komponent klienta, `requireAuth:false` |
| Odczyt | `GET /api/sales/quotes/public/[token]` |
| Akceptacja | `POST /api/sales/quotes/accept` |

Obie operacje idą z przeglądarki przez `apiCallOrThrow`, więc obie niosą ciasteczka sesji.

## Dlaczego „widzi, a nie może zaakceptować" — 5 asymetrii GET vs POST

`GET` nie sprawdza **niczego** poza tenantem. `POST` dokłada cztery bramki.
Każda z nich przepuszcza podgląd i wywraca akceptację.

### 1. Status musi być dokładnie `sent` (400)

`accept/route.ts`: `if ((quote.status ?? null) !== 'sent') → 400 invalidStatus`.
`GET` nie sprawdza statusu wcale — zwraca ofertę w każdym statusie.

Najmocniejszy kandydat, bo pasuje do „obejrzał, potem nie może":
**oferta została już raz zaakceptowana** → `status='confirmed'`, ale `acceptanceToken`
zostaje na rekordzie, więc strona nadal się renderuje. Drugie kliknięcie = błąd.

Wariant drugi: ktoś edytował ofertę po wysłaniu. `sales.quotes.update` cofa status na
`draft` **i czyści `acceptanceToken` oraz `sentAt`** (udokumentowane w
`.ai/specs/2026-09-19-rfq-quote-create-command.md`, sekcja UI/UX). Wtedy jednak padłby już
podgląd, więc ten wariant **nie** pasuje do objawu.

### 2. Origin guard — 403 (`accept/originGuard.ts`)

```ts
const expectedOrigin = new URL(req.url).origin        // to, co widzi serwer
const requestOrigin  = req.headers.get('origin')      // to, co wysyła przeglądarka
```

`isSafeMethod` przepuszcza `GET`/`HEAD`/`OPTIONS` bez sprawdzenia, więc podgląd nigdy tu nie padnie.
`POST` z niezgodnym originem → 403 „Cross-site quote acceptance is not allowed."

Kiedy to strzela: TLS terminowany na proxy (serwer widzi `http://`, przeglądarka wysyła `https://`),
`APP_URL` wskazujący inny host niż ten, na którym faktycznie stoi aplikacja, custom domain,
ngrok/tunel. **`APP_URL` jest tu kluczowe, bo to on buduje link w mailu** — jeśli rozjeżdża się
z hostem widzianym przez Next, podgląd działa, a akceptacja nie.

Wyłącznik awaryjny: `OM_ENABLE_CORS_VALIDATION=false` (domyślnie `true`).
To potwierdzenie hipotezy, nie naprawa.

### 3. Wygaśnięcie (400)

`GET` zwraca tylko flagę `isExpired: true` i renderuje stronę normalnie.
`POST` twardo odrzuca, gdy `validUntil < now`. Oferta po terminie = widoczna, nieakceptowalna.

### 4. Rate limit — 429

`SALES_QUOTES_ACCEPT`: 10 prób / 60 s, blokada **300 s**. Jeśli Marek klikał wielokrotnie,
każde kolejne kliknięcie pada niezależnie od pierwotnej przyczyny. Sprawdzić przed resztą,
bo maskuje wszystko inne.

### 5. `convert_to_order` wywala transakcję → generyczne 400

Akceptacja to nie tylko zmiana statusu: w tej samej transakcji leci
`sales.quotes.convert_to_order`. Jeśli konwersja rzuci, rollback obejmuje też zmianę statusu,
a klient dostaje `sales.quotes.accept.failed` bez żadnego szczegółu.
Kandydaci w tej apce: brak sekwencji numeracji dokumentów, brak kanału sprzedaży, brak słownika
`sales.order_status` (spec mówi wprost, że **nic w tej aplikacji tego słownika nie tworzy**).

Uwaga na nasz interceptor `deal_links.link-converted-order`
(`src/modules/deal_links/commands/interceptors.ts`) — pnie się na `convert_to_order`.
Przy `ctx.auth = null` (a accept ustawia właśnie `auth: null`) wychodzi cicho przez
`if (!tenantId || !organizationId) return`, więc **nie** powinien być przyczyną —
ale jego `em.flush()` w `afterExecute` biegnie po commicie, a route obsługuje
`getCommandInterceptorHttpRejection`. Warto wykluczyć pomiarem, nie założeniem.

## Czemu nie wiemy, który to — i to jest osobna usterka

`page.tsx:96` łyka odpowiedź serwera w całości:

```ts
catch (err) { setError(t('sales.quotes.public.acceptFailed')) }
```

403, 404, 400 i 429 renderują się jako **jeden i ten sam komunikat**. Marek nie ma jak
powiedzieć, co się stało, a my nie mamy jak zgadnąć bez zajrzenia do sieci albo logów.

## Kolejność weryfikacji — od najtańszej

1. **Network tab przy kliknięciu „Akceptuj".** Status HTTP + ciało odpowiedzi rozstrzygają
   między tropami 1–5 w jednym ruchu. To jedyny krok, który *musi* zrobić człowiek przy
   przeglądarce, i on kończy śledztwo.
2. **Stan oferty w bazie** — czy to nie jest po prostu trop 1:
   ```sql
   SELECT id, quote_number, status, sent_at, valid_until,
          acceptance_token IS NOT NULL AS has_token, updated_at
   FROM sales_quotes
   WHERE acceptance_token IS NOT NULL
   ORDER BY updated_at DESC
   LIMIT 20;
   ```
   `status='confirmed'` → trop 1 potwierdzony. `valid_until < now()` → trop 3.
3. **Czy zamówienie jednak powstało** (rozstrzyga trop 5 — błąd po udanej konwersji):
   ```sql
   SELECT id, order_number, created_at FROM sales_orders ORDER BY created_at DESC LIMIT 10;
   ```
4. **`APP_URL` kontra host aplikacji** (trop 2). Porównać `APP_URL` w środowisku z hostem
   w pasku adresu i ze schematem (`http`/`https`). Rozjazd = 403.
5. **Log serwera** — `sales.quotes.accept failed` z pełnym `err` leci przez
   `createLogger('sales')` tylko w gałęzi generycznej (trop 5). Brak tego wpisu przy
   jednoczesnym błędzie u klienta **wyklucza** trop 5 i zawęża do 1–4.

## Co warto poprawić niezależnie od wyniku

- Przekazać komunikat serwera na stronę publiczną zamiast jednego `acceptFailed`.
  Bez tego każdy następny taki zgłoszony błąd kosztuje to samo śledztwo od zera.
- Jeśli padnie trop 1: strona powinna dla `status='confirmed'` pokazywać „już zaakceptowano",
  a nie przycisk, który zawsze zwróci błąd.

---

# ROZSTRZYGNIĘTE — 2026-09-19: to origin guard, a nie status oferty

Objaw z produkcji: **403**. W `accept/route.ts` ten kod ma dokładnie jedno źródło —
`validateSameOriginMutationRequest`. Ciało odpowiedzi potwierdza:
`{"error":"Cross-site quote acceptance is not allowed."}` = klucz `sales.quotes.accept.forbidden`.
Tropy 1, 3, 4 i 5 z góry tej notatki są tym samym odrzucone.

## Pomiar

Host z maila: `https://demo.hackon.dev.evojam.com`
(link: `/quote/a3f43c0b-46e2-4259-bcbd-18f0392dd02c`).

`POST /api/sales/quotes/accept` z **losowym** UUID zamiast prawdziwego tokenu
(guard biegnie przed parsowaniem ciała, więc 403 zapada zanim token ma znaczenie;
losowy token gwarantuje, że nic nie może się zaakceptować):

| Nagłówek `Origin` | Odpowiedź |
|---|---|
| `https://demo.hackon.dev.evojam.com` — dokładnie to, co wysyła przeglądarka | **403** |
| `http://demo.hackon.dev.evojam.com` | 403 |
| `http://localhost:3000` | 403 |
| brak `Origin` i brak `Referer` | 403 |

## Co to znaczy

Żądanie niosące **poprawny, publiczny origin tej aplikacji zostaje odrzucone**.
Czyli `new URL(req.url).origin` po stronie serwera nie jest publicznym originem —
aplikacja za proxy nie odtwarza swojego zewnętrznego adresu.

Wniosek jest mocniejszy niż „Markowi nie działa": **na tym wdrożeniu żadna przeglądarka
nie jest w stanie zaakceptować żadnej oferty.** To nie zależy od sesji, tenanta ani od
konkretnej oferty.

Czego pomiar **nie** ustalił: jaką wartość serwer uważa za swój origin. Route zwraca 403
bez logowania `SameOriginViolation`, więc z zewnątrz tego nie widać — trzeba albo dołożyć
tymczasowy log, albo odczytać to w kontenerze.

## Co zrobić

1. **Odblokowanie demo, jeden env:** `OM_ENABLE_CORS_VALIDATION=false` na tasku aplikacji
   + restart. Koszt: znika ochrona CSRF na tym route. Na czas hackathonu akceptowalne,
   ale to obejście, nie naprawa.
2. **Naprawa:** doprowadzić do tego, żeby aplikacja widziała swój publiczny origin —
   `X-Forwarded-Proto` / `X-Forwarded-Host` z ALB i potwierdzenie, że Next 16 bierze je
   pod uwagę przy budowaniu `req.url`. **Tego nie sprawdziłem** i nie zgaduję.
3. **Zgłoszenie upstream:** guard wyprowadza oczekiwany origin z `req.url`, podczas gdy
   `APP_URL` jest już wymagany w produkcji i trzyma dokładnie tę wartość
   (`send/route.ts:203` buduje z niego link w mailu). Porównywanie do `APP_URL` byłoby
   odporne na proxy; obecny kształt psuje się na każdym wdrożeniu z terminacją TLS.

## Deployment — odczytane z AWS CLI (konto 139060264378, eu-central-1)

| Fakt | Wartość | Skąd |
|---|---|---|
| DNS | `demo.hackon.dev.evojam.com` → A-alias **wprost na ALB** `blueprint-2-quote-demo-alb` | `route53 list-resource-record-sets`, strefa `dev.evojam.com` |
| Przed ALB | **nic** — brak CDN, brak proxy przepisującego `Host` | jw. |
| Listener :80 | 301 → HTTPS:443 | `elbv2 describe-listeners` |
| Listener :443 | HTTPS → forward do `blueprint-2-quote-demo-tg` | jw. |
| Target group | **HTTP:3000**, target type `ip`, HC `/api/healthz` | `elbv2 describe-target-groups` |
| Serwis ECS | `blueprint-2-quote-demo-app`, Fargate, TD `:14`, 1 task, ExecuteCommand **on** | `ecs describe-services` |
| `APP_URL` (kontener `app`) | `https://demo.hackon.dev.evojam.com` — **poprawny** | `ecs describe-task-definition` |
| `NEXT_PUBLIC_APP_URL` | `https://demo.hackon.dev.evojam.com` | jw. |
| `PORT` / `HOSTNAME` | `3000` / `0.0.0.0` | jw. |
| `RATE_LIMIT_TRUST_PROXY_DEPTH` | `1` — ustawione zgodnie z DEPLOYMENT.md | jw. |
| `OM_ENABLE_CORS_VALIDATION` | **nieustawione** → domyślnie `true` | brak w `environment` |

**`APP_URL` jest poprawny i to nie ma znaczenia**, bo `originGuard.ts` nie czyta go w ogóle.
TLS kończy się na ALB, do kontenera idzie czyste HTTP na porcie 3000, więc `new URL(req.url).origin`
liczone jest z tego, co Next odtworzy z żądania — nie z konfiguracji.

## Co zostało nierozstrzygnięte

Sonda z zewnątrz odrzuciła cztery kandydatury na `expectedOrigin`
(`https://demo…`, `http://demo…`, `http://localhost:3000`, brak `Origin`).
Przy braku proxy przepisującego `Host` zostaje jeden mocny kandydat, którego jeszcze nie sprawdziłem:
**origin z portem**, `http://demo.hackon.dev.evojam.com:3000` lub wariant `https://…:3000` —
Next dokleja port nasłuchu, gdy nie bierze pod uwagę `X-Forwarded-Port`.
`PORT=3000` i target group HTTP:3000 to wspierają.

To rozstrzyga **którą** naprawę wybrać, nie **czy** jest problem.

---

# ROZSTRZYGNIĘTE DO KOŃCA — `expectedOrigin = https://localhost:3000`

## Jak zmierzone

`originGuard.ts` nie loguje odrzucenia, więc wartości nie widać wprost. Wyrocznią jest
`auth/api/locale/route.ts:85` — jedyny publiczny endpoint, który **zwraca** tę samą wartość:

```ts
const url = new URL(req.url)                                   // to samo, co readExpectedOrigin
const res = NextResponse.redirect(new URL(safePath, url.origin))
```

```
$ curl -sSD- -o /dev/null 'https://demo.hackon.dev.evojam.com/api/auth/locale?locale=pl&redirect=/start'
HTTP/2 307
location: https://localhost:3000/start      <-- new URL(req.url).origin
```

Potwierdzenie na samym endpointcie akceptacji (token losowy, więc sukces niemożliwy):

| `Origin` | Odpowiedź |
|---|---|
| `https://demo.hackon.dev.evojam.com` | 403 forbidden |
| `http://localhost:3000` | 403 forbidden |
| `http://demo.hackon.dev.evojam.com:3000`, `https://…:3000`, `http://0.0.0.0:3000`, `http://127.0.0.1:3000`, `http://app:3000` | 403 forbidden |
| **`https://localhost:3000`** | **404 „Quote not found."** — guard przepuścił |

## Mechanizm

Next.js standalone buduje `req.url` z **tożsamości nasłuchu**, nie z żądania:

- schemat bierze z `X-Forwarded-Proto` → `https` ✔
- host bierze z własnego `HOSTNAME`/`PORT`; `HOSTNAME=0.0.0.0` Next normalizuje do `localhost` → `localhost:3000` ✘

Zmierzone: `X-Forwarded-Host` **nie zmienia niczego** — wysłanie go (samego i razem z
`X-Forwarded-Port: 443`) dalej daje `https://localhost:3000`.

Przeglądarka wysyła `Origin: https://demo.hackon.dev.evojam.com`. Guard porównuje to z
`https://localhost:3000`. Nie zgadza się nigdy → 403 dla każdego klienta, zawsze.

## Dlaczego to NIE jest do naprawienia w terraformie

Sprawdziłem `evojam/aws`. `apps/blueprint-2-quote/modules/main/locals.tf:39` ustawia
`HOSTNAME=0.0.0.0` i jest to **świadome i konieczne** — `apps/evojam-platform/modules/main/locals.tf:52-56`
wyjaśnia dlaczego: Fargate wstrzykuje `HOSTNAME=<task compute hostname>`, który rozwiązuje się
tylko do IP ENI, a `server.js` robi `listen(PORT, HOSTNAME)`.

Stąd trzy zamknięte drogi:

- **`HOSTNAME=demo.hackon.dev.evojam.com`** — Next próbowałby zbindować nazwę publiczną,
  która w kontenerze nie jest lokalnym interfejsem. Task nie wstanie.
- **`X-Forwarded-Host` z ALB** — ALB nie potrafi wstrzykiwać nagłówków, a Next i tak go ignoruje
  (zmierzone wyżej). Sidecar-proxy też nic nie da z tego samego powodu.
- **`OM_ENABLE_CORS_VALIDATION=false`** — działa, ale wyłącza ochronę. Odrzucone.

`APP_URL` i `NEXT_PUBLIC_APP_URL` są poprawne (`locals.tf:66-67`, pilnuje tego test
`composition.tftest.hcl:395`) i nie mają tu wpływu, bo guard ich nie czyta.

**Wniosek: terraform jest poprawny. Usterka jest w kodzie `@open-mercato/core`.**

## Naprawa — framework ma już własny kanoniczny helper, którego guard nie użył

`@open-mercato/shared/src/lib/url.ts:236-248`:

```ts
export function resolveRequestOrigin(req: Request): string {
  const url = new URL(req.url)
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host  = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host
  return `${proto}://${host}`
}

export function getAppBaseUrl(req: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || resolveRequestOrigin(req)
}
```

To jest dokładnie ta obsługa proxy, której brakuje. `auth/api/locale/route.ts` używa
`getAppBaseUrl(req)` do walidacji przekierowania — i **w tej samej funkcji** sięga po surowe
`url.origin` do zbudowania `Location`. Guard akceptacji poszedł tą drugą, złą drogą.

### Poprawka (upstream, `sales/api/quotes/accept/originGuard.ts`)

```diff
+import { getAppBaseUrl } from '@open-mercato/shared/lib/url'
+
 function readExpectedOrigin(req: Request): string | null {
   try {
-    return new URL(req.url).origin
+    // Za proxy `req.url` niesie tożsamość nasłuchu (https://localhost:3000 na Fargate
+    // z HOSTNAME=0.0.0.0), a nie publiczny origin. getAppBaseUrl bierze skonfigurowany
+    // APP_URL, a dopiero w ostateczności odtwarza origin z X-Forwarded-*.
+    return new URL(getAppBaseUrl(req)).origin
   } catch {
     return null
   }
 }
```

Ochrona CSRF **zostaje włączona i dopiero zaczyna działać naprawdę**: porównuje origin
przeglądarki z publicznym originem aplikacji zamiast z adresem nasłuchu, którego żadna
przeglądarka nigdy nie wyśle.

Testy do dołożenia przy poprawce (obecne `__tests__` guardu tego nie pokrywają):
żądanie z `Origin` równym `APP_URL` i `req.url = https://localhost:3000/...` musi przejść;
żądanie z obcym `Origin` przy tym samym `req.url` musi dać 403.

### Do czasu wydania upstream

Dwie opcje, obie wymagają Twojej decyzji (AGENTS.md → *Ask First*: osłabianie
bezpieczeństwa / kontrakt installed):

1. **Override installed route** `sales/api/quotes/accept` w `src/modules/` z poprawnym
   guardem. Utrzymuje ochronę, ale kopiuje ~180 linii installed route'u i trzeba to cofnąć
   po podbiciu wersji.
2. **`OM_ENABLE_CORS_VALIDATION=false`** w terraformie na czas hackathonu, z komentarzem
   linkującym do zgłoszenia upstream. Jedna linia, odwracalne, ale świadomie wyłącza CSRF
   na tym route.

## Osobno: strona publiczna gubi komunikat serwera

`sales/frontend/quote/[token]/page.tsx:96` zamienia 403/404/400/429 w jeden
`sales.quotes.public.acceptFailed`. To kosztowało całe to śledztwo. Warte zgłoszenia
upstream razem z powyższym.

---

# Wdrożone: zgłoszenie upstream + override

## Upstream

https://github.com/open-mercato/open-mercato/issues/6283 — feature request z use case'em,
pomiarami i diffem. Hosty w zgłoszeniu zanonimizowane do `demo.example.com`, bo repo jest publiczne.

## Override w tym repo

| Plik | Co |
|---|---|
| `src/lib/publicQuoteAcceptOrigin.ts` | `withPublicOrigin()` przepisuje URL żądania na publiczny origin z `getAppBaseUrl`; `acceptPublicQuote()` opakowuje installed `POST`; `PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE` jest jedynym właścicielem klucza |
| `src/bootstrap-common.ts` | `applyApiRouteOverrides(PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE)` tuż po `applyModuleOverridesFromEnabledModules` |
| `src/lib/__tests__/publicQuoteAcceptOrigin.test.ts` | 10 przypadków: 5 na zachowanie, 3 przez prawdziwy installed guard, 1 na klucz, 1 na wpięcie w bootstrap |

Mechanizm potwierdzony w źródłach `@open-mercato/shared@0.8.0`:

- `modules/overrides.ts:376` — `ApiRouteOverrideDefinition { handler, metadata? }`
- `modules/overrides.ts:829` — `applyApiRouteOverrides`, warstwa programatyczna
- `modules/overrides.ts:1042` — `applyApiOverridesToManifests`: akceptuje klucz publiczny
  `'METHOD /api/...'` **albo** manifestowy, podmienia `out[METHOD]`, a `def.metadata`
  dokleja **tylko gdy podane** → pominięcie zachowuje installed `{ requireAuth: false }`
- `modules/registry.ts:465` — `registerApiRouteManifests` woła composer przed zapisem manifestu

Żądanie jest przenoszone w całości (metoda, nagłówki, ciało), więc `getAuthFromRequest`
(ciasteczko), `getClientIp` (`x-forwarded-for`) i `quoteAcceptSchema` (ciało) działają jak wcześniej.
Ciało czytane jako tekst, nie strumień — strumień w Node wymaga `duplex: 'half'`.

### Dlaczego NIE przez `entry.overrides.routes.api` w `src/modules.ts`

Pierwsza wersja poszła tą drogą, bo tam kieruje
`.ai/skills/om-system-extension/references/unified-overrides.md`. **`yarn build` padł
z 48 błędami Turbopacka**, a trace importów nazwał przyczynę wprost:

```
./node_modules/@open-mercato/core/dist/modules/sales/api/quotes/accept/route.js [Client Component Browser]
./src/lib/publicQuoteAcceptOrigin.ts [Client Component Browser]
./src/modules.ts [Client Component Browser]
./src/components/ClientBootstrap.tsx [Client Component Browser]
./src/app/layout.tsx
```

`ClientBootstrap.tsx:66` robi `import('@/modules')` **w przeglądarce**, żeby zastosować
override'y widgetów i notyfikacji. `src/modules.ts` jest więc z założenia client-reachable,
a nazwanie tam server-only handlera ciągnie `server-only` do bundla klienta. Leniwy
`import()` wewnątrz handlera tego nie ratuje — Turbopack i tak przechodzi tę krawędź.

Warstwa programatyczna w `bootstrap-common.ts` nie ma tego problemu: ten plik importują
wyłącznie `bootstrap.ts` i `bootstrap-api.ts`, oba serwerowe. Kolejność jest nośna —
`registerApiRouteManifests` czyta store **raz**, więc wywołanie po rejestracji manifestów
nie zadziałałoby wstecz; instrukcje na poziomie modułu w tym pliku wykonują się, zanim
`createBootstrap(...)` w ogóle ruszy.

### Dokument, który wprowadził w błąd

`unified-overrides.md` kończy się zdaniem, że `src/modules.ts` „carries typed, **inactive**
`entry.overrides` examples for every wired override domain". W tym repo `src/modules.ts` ma
108 linii i **zero** przykładów override'ów. Poza tym reference nigdzie nie ostrzega, że w
tej aplikacji `modules.ts` jest wykonywany także w przeglądarce, co dyskwalifikuje całą
domenę `routes.api` dla installed route'ów serwerowych.

## Walidacja — wykonana

Node 24.21.0 przez nvm, yarn 4.17.1 przez corepack.

| Bramka | Wynik |
|---|---|
| `yarn generate` | OK |
| `yarn typecheck` | exit 0 |
| `yarn lint` | exit 0 (9 ostrzeżeń, wszystkie zastane, żadne w nowych plikach) |
| `yarn test` | 26 suite, **266 testów**, wszystkie zielone |
| `yarn build` | exit 0 |

Pominięte świadomie: `yarn ds:check` i `yarn i18n:check-hardcoded` — diff nie dotyka
renderowanego UI ani stringów użytkownika.

### Bypass CSRF, który sam wprowadziłem

Pierwsza wersja wrappera brała origin z `getAppBaseUrl(req)`. Ta funkcja ma ostatni
fallback `resolveRequestOrigin(req)`, który czyta host z **`x-forwarded-host` albo `host`** —
czyli z nagłówków kontrolowanych przez atakującego. Mój komentarz w kodzie opisywał ten
fallback jako zaletę.

Zmierzone przeciw prawdziwemu installed guardowi, bez `APP_URL` i `NEXT_PUBLIC_APP_URL`,
z `Origin: https://evil.example` i `X-Forwarded-Host: evil.example`:

```
WRAPPED URL           = https://evil.example/api/sales/quotes/accept
GUARD VERDICT         = null                      <-- przepuszczony
BASELINE (bez wrappera) = {"reason":"cross-origin", ...}   <-- odrzucony
```

Wrapper zamieniał guard fail-closed w przepuszczalny. Poprawka: czytać `NEXT_PUBLIC_APP_URL`
/ `APP_URL` wprost z env i **przepuszczać żądanie bez zmian**, gdy żadnego nie ma — wtedy
guard zachowuje swój własny werdykt.

Skala, uczciwie: ten endpoint ma `requireAuth: false` i autoryzuje sekretnym tokenem w
ciele, więc CSRF jest tu defence-in-depth, nie granicą uwierzytelnienia. Na demo obie
zmienne są ustawione, więc nie było wykorzystywalne. Ale wrapper nie ma prawa zostawić
guardu słabszym, niż go zastał.

### Trzy testy widziane na czerwono

Nie „powinny łapać", tylko złapały:

1. **Zachowanie.** Usunięcie przepisywania URL-a (`return req` zaraz po bramce równości)
   → 3 przypadki na czerwono. Przy okazji wyszło, że test „carries method, headers and body"
   przechodził mimo zepsutej logiki, bo asertował na nietkniętym żądaniu — dołożona
   asercja originu na początku tego przypadku jest tym, co go teraz czerwieni.
2. **Klucz.** Podmiana klucza na `POST /api/sales/quotes/accept-renamed-upstream`
   → przypadek na czerwono. To bramka na cichą śmierć override'u: `applyApiOverridesToManifests`
   na nietrafiony klucz tylko loguje ostrzeżenie i idzie dalej.
3. **Bezpieczeństwo i wpięcie.** Przywrócenie fallbacku na `x-forwarded-host` czerwieni
   przypadek ze sfałszowanym hostem; usunięcie `applyApiRouteOverrides(...)` z
   `bootstrap-common.ts` czerwieni bramkę wpięcia. Bez tej drugiej override może umrzeć
   po cichu, bo wszystkie pozostałe testy wołają helper bezpośrednio.

Pozytywne potwierdzenie samego klucza: `.mercato/generated/openapi.generated.json` zawiera
`/api/sales/quotes/accept` z metodą `post`, a w logu builda nie ma ani jednego wystąpienia
`did not match any registered API route`.

## NIEZWERYFIKOWANE

Nie uruchomiłem `yarn test:integration:ephemeral` ani samej aplikacji — to wymaga bazy.
Sprawdzenie end-to-end zostaje na wdrożeniu:

```fish
# fish i bash — to samo polecenie
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://demo.hackon.dev.evojam.com/api/sales/quotes/accept \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://demo.hackon.dev.evojam.com' \
  -d '{"token":"11111111-2222-4333-8444-555555555555"}'
```

Przed poprawką: `403`. Po poprawce ma być `404` (token losowy, więc sukces niemożliwy).
To ten sam pomiar, który usterkę zidentyfikował, więc odwraca się jeden do jednego.
