# 04 — Testy, fazy, wdrożenie i zgodność

**Spec**: Przedmiar remontowy → wycena (wariant uproszczony)
**Date**: 2026-09-19
**Status**: Draft
**Indeks**: [README.md](./README.md) · **Poprzedni**: [03 — API, zdarzenia, UI](./03-api-events-ui.md) · **Następny**: —

> Oracles, cztery fazy z bramkami wyjścia, traceability, rollout i rollback, ryzyka, kryteria akceptacji, raport zgodności, pytania otwarte.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TL-001 | integration | tenant A, deal `renovation`, produkty `MAL-SCIAN-2W` (m2) i `FARBA-LATEX-B` (l) z cenami progowymi | pomieszczenie 4,2×3,6×2,7 z oknem 1,4×1,5 ×2; pozycja zakresu z bazą `wall_area`; pozycja `manual` 9,10 l | `floor_area_m2 = 15,1200`, `wall_area_net_m2 = 37,9200`, `perimeter_m = 15,6000`; ilość pozycji `wall_area` = 37,9200; pozycja `manual` nietknięta | REQ-L-001, REQ-L-002 |
| TL-002 | integration | jak wyżej, po zmianie wysokości na 3,0 | `PUT` pomieszczenia | `wall_area_net_m2 = 42,6000`; ilość pozycji `wall_area` przeliczona na 42,6000; pozycja `manual` nadal 9,10 | REQ-L-001, REQ-L-002 |
| TL-003 | integration | zakres z dwiema pozycjami | `quotes.generate` | powstaje `SalesQuote` z `deal_id` i `takeoff_snapshot_at`; dwie linie z `kind: 'service'`, ilością, jednostką, `catalog_snapshot` i ceną; sumy i VAT policzone przez `sales`; event `quote.generated` | REQ-L-003 |
| TL-004 | integration | jak wyżej | `quotes.generate` dwa razy bez zmian w przedmiarze, potem po zmianie ilości | drugie wywołanie zwraca ten sam `quoteId`; po zmianie powstaje drugi dokument z nowym numerem i tym samym `deal_id`; pierwsza oferta bez zmian | REQ-L-004 |
| TL-005 | security | tenant A i tenant B | zapis pomieszczenia z `dealId` należącym do B w kontekście A; odczyt pozycji A w kontekście B; pozycja zakresu z produktem spoza scope | 403/404, brak zapisu, brak wycieku pól w treści błędu | REQ-L-008 |
| TL-006 | integration | zakres pusty; zakres z produktem bez ceny w kontekście klienta | `quotes.generate` | pusty → 422 i brak dokumentu; bez ceny → dokument powstaje, linia z zerem, flaga w `warnings` odpowiedzi | REQ-L-003 |
| TL-007 | integration | webhook mostu z mailem z PDF i JPG | `POST` na trasę mostu z poprawnym podpisem, potem powtórzenie | dwa `Attachment`; `takeoff.start` tworzy jeden deal z custom fields; powtórka nie tworzy drugiego; event `started` z `hasAttachments: true` | REQ-L-005 |
| TL-008 | integration | proces z triggerem na `renovation_takeoff.started`, filtr `hasAttachments` | start z maila z załącznikami; start ręczny bez załączników | pierwszy startuje `WorkflowInstance` z `dealId` z `contextMapping`; drugi nie startuje nic; żadna definicja procesu nie subskrybuje `customers.*` ani `inbox_ops.*` | REQ-L-005, REQ-L-006 |
| TL-009 | integration | agent zwracający `research` z dwoma pomieszczeniami | uruchomienie procesu na dealu z załącznikiem | `TakeoffRoom` ×2 utworzone wyłącznie przez `takeoff.rooms.upsert`; powierzchnie policzone przez nasz kod, nie przyjęte z ładunku agenta; `AgentRun` w audycie | REQ-L-006 |
| TL-010 | integration | propozycja wstrzyknięta bez agenta (`runs.create` + `proposals.create`, `workflowInstanceId: null`) | `dispose` `approved`, osobno `edited`, osobno `rejected` | efektor wykonuje zmapowane komendy; `edited` stosuje zmieniony ładunek do wybranej opcji; `rejected` nie zapisuje nic | REQ-L-007 |
| TL-011 | integration | propozycja z akcją spoza `actionCommandMap` i z komendą wyłączoną u tenanta | `dispose` `approved` i wykonanie efektora | obie wracają jako `skipped` z powodem, nie jako błąd; żaden rekord nie powstaje; wynik widoczny w logu przebiegu | REQ-L-007 |
| TL-012 | UI | deal z trzema pomieszczeniami i dwiema pozycjami zakresu | przejście po zakładce „Przedmiar": loading, empty, dodanie otworu, konflikt 409, nawigacja klawiaturą, tryb jasny i ciemny, wąskie okno | powierzchnie ogłoszone przez `aria-live`; dialog zamykany Escape; 409 nie gubi wprowadzonych danych; brak zapisanych na sztywno kolorów | REQ-L-001, REQ-L-002 |
| TL-013 | UI | wycena z przedmiaru i wycena wpisana ręcznie w `sales` | render `/backend/sales/quotes/[id]` dla obu | widget pokazuje panel przedmiaru dla pierwszej, stan pusty dla drugiej; wymuszona awaria enrichera nie psuje strony | REQ-L-003 |
| TL-014 | integration | deal z przedmiarem | `customers.deals.delete` | subscriber soft-deletuje pomieszczenia, otwory i zakres; ponowne wywołanie nie zmienia stanu | REQ-L-008 |

## Implementation Phases

### Phase L1 — Przedmiar

- **Depends on:** none
- **Outcome:** kosztorysant prowadzi przedmiar na dealu i widzi policzone powierzchnie.
- **Why this order / value delivered:** zastępuje kalkulator i arkusz obmiaru; wartość dostępna zanim powstanie jakakolwiek wycena.
- **Deliverables:** moduł `src/modules/renovation_takeoff/` — `index.ts`, `acl.ts`, `ce.ts` (custom fields na dealu), `di.ts`, `events.ts`, `setup.ts`, encje `TakeoffRoom`, `TakeoffOpening`, `TakeoffScopeItem`, walidatory, komendy przedmiaru z przeliczaniem powierzchni, trasy CRUD, zakładka „Przedmiar" przez injection na stronie deala, `i18n`, migracja + snapshot; wpis w `src/modules.ts`.
- **Independent slices:** encje i walidatory; komendy z wyliczeniami; trasy CRUD; UI zakładki.
- **Requirements closed:** REQ-L-001, REQ-L-002
- **Tests:** TL-001, TL-002, TL-005, TL-012, TL-014
- **Validation:** `yarn generate`, `yarn db:generate`, `yarn typecheck`, `yarn lint`, `yarn ds:check`, `yarn test`, `yarn test:integration:ephemeral`
- **Exit gate:** pomieszczenie 4,2×3,6×2,7 z oknem 1,4×1,5 ×2 daje `wall_area_net_m2 = 37,9200` zapisane w bazie; zmiana wysokości przelicza ilości pozycji `wall_area` i nie rusza `manual`; obcy `dealId` odrzucony; zakładka zweryfikowana w trybie jasnym, ciemnym i przy zawężonym oknie.

### Phase L2 — Generowanie wyceny

- **Depends on:** Phase L1 exit gate
- **Outcome:** pełny przepływ ręczny działa end-to-end: przedmiar → `SalesQuote` z cenami i sumami.
- **Why this order / value delivered:** to jest produkt. Po tej fazie system zastępuje arkusz bez AI i bez maila.
- **Deliverables:** `lib/priceScope.ts` (wycena batchem przez `resolvePriceMany`), komenda `quotes.generate` z idempotencją, custom fields na `E.sales.sales_quote`, zakładka „Wyceny", enricher `_takeoff` + widget na stronie wyceny, subscriber aktualizujący `value_amount` deala, subscriber na `catalog.price.updated`.
- **Independent slices:** wycena i budowa linii; komenda generowania; zakładka wycen; enricher i widget.
- **Requirements closed:** REQ-L-003, REQ-L-004
- **Tests:** TL-003, TL-004, TL-006, TL-013
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn ds:check`, `yarn test`, `yarn test:integration:ephemeral`
- **Exit gate:** wycena wygenerowana z zakresu ma ilości i ceny ze snapshotem, a jej sumy zgadzają się co do grosza z sumą linii; powtórne generowanie bez zmian zwraca ten sam dokument; pusty zakres daje 422.

### Phase L3 — Wejście mailowe

- **Depends on:** Phase L2 exit gate
- **Outcome:** mail z dokumentacją zakłada sprawę z zapisanymi załącznikami i emituje nasze zdarzenie.
- **Why this order / value delivered:** skraca drogę od zapytania klienta do sprawy; warunek konieczny dla fazy agentowej.
- **Deliverables:** komenda `takeoff.start` (tworzy deala przez `customers.deals.create`, zapisuje custom fields, emituje `renovation_takeoff.started` z pełnym ładunkiem), trasa mostu `api/inbound/route.ts` z weryfikacją podpisu, `lib/emailAttachments.ts` na `communication_channels/lib/email-mime.ts` i `attachments` `StorageDriver`, `inbox-actions.ts` z akcją `start_renovation_takeoff`, sekcja „Źródło" na zakładce przedmiaru.
- **Independent slices:** komenda `takeoff.start` i event; most i zapis załączników; akcja inbox; UI źródła.
- **Requirements closed:** REQ-L-005
- **Tests:** TL-007
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn test`, `yarn test:integration:ephemeral`
- **Exit gate:** mail z dwoma załącznikami tworzy dwa `Attachment` i jeden deal emitujący `started` z `hasAttachments: true`; powtórzenie nie tworzy drugiego; `inbox_ops` nie zna żadnego identyfikatora agenta ani procesu.

### Phase L4 — Agent

- **Depends on:** Phase L3 exit gate
- **Outcome:** deal z dokumentacją dostaje przedmiar wstępny i zaproponowany zakres; kosztorysant zaczyna od gotowej wyceny w statusie `proposed`.
- **Why this order / value delivered:** największa oszczędność czasu, ale wymaga działającego fundamentu i realnych danych do kalibracji progu.
- **Deliverables:** włączenie `OM_ENABLE_ENTERPRISE_MODULES` + `_AGENTS`; **najpierw** rejestracja komend workflow-safe i efektor `lib/proposalEffector.ts` z `actionCommandMap` plus harness wstrzykiwania propozycji — odblokowuje testowanie akceptacji bez LLM; potem file-agent `agents/takeoff_doc_reader/` (OpenCode, `research`), agent proponujący pozycje katalogowe, `WorkflowDefinition` i `ProcessDefinition` z triggerem `event`, aktywności przenoszące `research` na komendy.
- **Independent slices:** komendy workflow-safe; efektor + harness; agent czytający dokumenty; agent proponujący zakres; definicja workflow i procesu.
- **Requirements closed:** REQ-L-006, REQ-L-007
- **Tests:** TL-008, TL-009, TL-010, TL-011
- **Validation:** `yarn generate`, restart kontenera OpenCode, `mercato ai_assistant mcp:list-tools` (pełny zestaw, nie trzy narzędzia Code Mode), `yarn typecheck`, `yarn test`, `yarn test:integration:ephemeral`
- **Exit gate:** wstrzyknięta propozycja przechodzi pełną ścieżkę akceptacji bez agenta; akcja bez mapowania wraca jako `skipped`; deal z rzutem daje `TakeoffRoom` utworzone wyłącznie przez komendę, z powierzchniami policzonymi przez nasz kod; proces nie startuje dla sprawy bez załączników.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-L-001 | JL-001 kroki 1–2, zakładka „Przedmiar" | `TakeoffRoom`, `TakeoffOpening`; `/api/renovation-takeoff/rooms`, `…/openings`; `rooms.updated` | L1 | TL-001, TL-002, TL-005, TL-012, TL-014 | AC-L-001 |
| REQ-L-002 | JL-001 krok 3 | `TakeoffScopeItem`; `/api/renovation-takeoff/scope`; `scope.updated` | L1 | TL-001, TL-002, TL-012 | AC-L-002 |
| REQ-L-003 | JL-001 kroki 4–5, widget na wycenie | `renovation_takeoff.quotes.generate`; `sales.quotes.create`; `quote.generated` | L2 | TL-003, TL-006, TL-013 | AC-L-003 |
| REQ-L-004 | JL-002, zakładka „Wyceny" | custom field `deal_id` na `E.sales.sales_quote`; `GET /api/renovation-takeoff/quotes` | L2 | TL-004 | AC-L-004 |
| REQ-L-005 | JL-003 kroki 1–3 | trasa mostu, `Attachment`, `InboxEmail`, `inbox-actions.ts`, komenda `takeoff.start`, event `started` | L3 | TL-007, TL-008 | AC-L-005 |
| REQ-L-006 | JL-003 kroki 4–6 | trigger `event` + `filterConditions`/`contextMapping`, `input.__files`, `takeoff.rooms.upsert` | L4 | TL-008, TL-009 | AC-L-006 |
| REQ-L-007 | JL-003 kroki 7–8 | `AgentProposal`, `DispositionService`, `executeProposal` + `actionCommandMap`, `takeoff.scope.upsert` | L4 | TL-010, TL-011 | AC-L-007 |
| REQ-L-008 | wszystkie powierzchnie | asercja scope w komendach, walidacja przynależności deala, subscriber na usunięcie deala | L1–L4 | TL-005, TL-014 | AC-L-008 |

## Rollout, Migration, and Rollback

- **Migracje:** `yarn db:generate` po zmianie encji, przegląd SQL i snapshotu, aplikacja osobną decyzją. Trzy tabele, żadna migracja nie dotyka installed.
- **Custom fields:** rejestrowane w `ce.ts` modułu przeciwko `E.customers.customer_deal` i `E.sales.sales_quote`; pojawiają się po `yarn generate`, bez migracji.
- **Status `proposed`:** dodawany do słownika statusów wyceny w `setup.ts` modułu. Wartość, nie zmiana schematu.
- **ACL:** nowe features w `setup.ts` `defaultRoleFeatures` + `yarn mercato auth sync-role-acls`; bez tego istniejący użytkownicy dostają 403 na nowej zakładce.
- **Enterprise:** flagi środowiskowe włączane dopiero w Phase L4; do tego czasu `.env` bez zmian.
- **Komendy workflow-safe:** bez `defaultEnabled`, więc tenant włącza je świadomie; wyłączenie ustawienia natychmiast blokuje efektor bez wdrożenia kodu.
- **Obserwowalność:** metryki — odsetek wycen wygenerowanych z przedmiaru, odsetek linii bez ceny, liczba wersji na deal, czas od `started` do pierwszej wyceny.
- **Rollback:** usunięcie wpisu z `src/modules.ts` zdejmuje trasy, zakładki, zdarzenia i komendy po `yarn generate`; migracja w dół kasuje trzy tabele. Deale i wyceny zostają nietknięte — tracą tylko custom fields i panel widgetu. Phase L4 cofa się przestawieniem flagi env.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| **Brak receptur — materiał nie dolicza się sam** | Kosztorys bez farby, gruntu i taśmy; zaniżona oferta i brak podstawy do zamówienia materiału | Pozycje materiałowe wpisywane jako osobne wiersze zakresu; alternatywnie materiał wliczony w cenę usługi w `catalog`; checklista przy generowaniu wyceny ostrzegająca, gdy zakres ma wyłącznie pozycje usługowe | **Akceptowane świadomie — to jest cena tego wariantu.** Rozwiązanie docelowe: moduł receptur, patrz droga rozbudowy w 01 |
| Wycena dla klienta to jednocześnie kalkulacja wewnętrzna | Klient widzi rozbicie pozycji i pośrednio strukturę kosztów | Pozycje nazywane językiem klienta, nie wewnętrznym; materiał wliczony w usługę tam, gdzie to możliwe | Akceptowane w tym wariancie |
| Wersja `proposed` napisana przez agenta jest wysyłalna | Oferta niezweryfikowana trafia do klienta | Status `proposed` widoczny i filtrowalny; procedura: wysyłka dopiero po przejściu na `draft`/`sent`; widget na wycenie pokazuje pochodzenie | **Nie jest egzekwowane strażnikiem.** Egzekwowanie wymaga mutation guarda UMES na komendach `sales` — poza zakresem tego wariantu |
| Każda wersja zjada numer z `sales_document_sequences` | Numery ofert nieciągłe z perspektywy klienta | Generowanie wyceny dopiero po skompletowaniu zakresu; idempotencja blokuje bliźniacze dokumenty | Akceptowane; alternatywa to własny `quoteNumber` w ładunku, co odbiera OM rolę źródła numeracji |
| `site_address` jako pole EAV | Dane osobowe poza mapą szyfrowania modułu | **Q-L-001 — blokujące.** Rozstrzygnąć przed Phase L1: albo pole EAV jest szyfrowane, albo adres wraca do kolumny we własnej tabeli | — |
| Obcy `dealId` w ładunku przypina przedmiar do cudzej sprawy | Wyciek międzytenantowy | Walidacja przynależności deala do scope przy każdym zapisie; TL-005 jako bramka | — |
| Zmiana wymiarów po wygenerowaniu wyceny | Oferta rozjeżdża się z przedmiarem | `takeoff_snapshot_at` na wycenie; zakładka „Wyceny" oznacza dokumenty starsze niż ostatnia zmiana przedmiaru | Operator może świadomie wysłać rozjechaną ofertę |
| Akcja bez wpisu w `actionCommandMap` wraca jako `skipped` | Zatwierdzona propozycja nic nie robi, a operator widzi „zaakceptowano" | Mapa i lista typów akcji z jednego pliku kontraktu; TL-011 jako bramka; wynik efektora logowany per akcja | Nowy typ akcji bez wiersza w mapie — wychwyci test |
| Import encji `catalog` łamie się przy upgrade OM | Build nie przechodzi | Import ograniczony do encji i tokenów DI wymienionych w tym spec; `yarn typecheck` w bramce; przed upgrade `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` | Zmiana semantyki bez zmiany sygnatury — wychwyci TL-003 |
| Skala: deal z 60 pomieszczeniami i 200 pozycjami | Wolne generowanie, timeouty | Jedno zapytanie po pomieszczenia i zakres, jedno po produkty, rozstrzyganie cen batchem; limit 500 linii na wycenę z czytelnym błędem | Bardzo duże obiekty dzielone na osobne deale |

## Acceptance Criteria

- [ ] **AC-L-001** — Kosztorysant z `renovation_takeoff.takeoff.manage` wprowadza pomieszczenie 4,2×3,6×2,7 m z dwoma oknami 1,4×1,5 m i otrzymuje `floor_area_m2 = 15,1200`, `wall_area_net_m2 = 37,9200` i `perimeter_m = 15,6000` zapisane w bazie.
- [ ] **AC-L-002** — Pozycja zakresu z bazą `wall_area` dostaje ilość 37,9200; po zmianie wysokości pomieszczenia na 3,0 przelicza się na 42,6000, a pozycja o bazie `manual` pozostaje niezmieniona.
- [ ] **AC-L-003** — `quotes.generate` na zakresie z dwiema pozycjami tworzy `SalesQuote` z `deal_id`, dwiema liniami `kind: 'service'` z ilością, jednostką, `catalog_snapshot` i ceną, a sumy dokumentu zgadzają się co do grosza z sumą linii. Pusty zakres daje 422 i nie tworzy dokumentu.
- [ ] **AC-L-004** — Powtórne `quotes.generate` bez zmian w przedmiarze zwraca ten sam `quoteId`; po zmianie ilości powstaje drugi dokument z nowym numerem i tym samym `deal_id`, a pierwszy pozostaje nietknięty.
- [ ] **AC-L-005** — Mail z dwoma załącznikami tworzy dwa `Attachment` i jeden deal z `deal_kind = 'renovation'`, `source_email_id` i `attachment_ids`, oraz emituje `renovation_takeoff.started` z `hasAttachments: true`; powtórzenie maila nie tworzy drugiego deala.
- [ ] **AC-L-006** — Proces startuje wyłącznie z `renovation_takeoff.started` i tylko dla sprawy z załącznikami; `TakeoffRoom` powstają wyłącznie przez `takeoff.rooms.upsert`, a powierzchnie są policzone przez nasz kod, nie przyjęte z ładunku agenta.
- [ ] **AC-L-007** — Propozycja spoza `actionCommandMap` lub z komendą wyłączoną u tenanta wraca jako `skipped` z powodem i nie zapisuje rekordu; zaakceptowana propozycja wykonuje komendy i zostawia `ActionLog` z atrybucją `source: 'agent'`.
- [ ] **AC-L-008** — Kontekst tenanta B otrzymuje 403/404 dla każdego rekordu tenanta A i nie może przypiąć przedmiaru do cudzego deala; usunięcie deala soft-deletuje jego przedmiar.
- [ ] Każda powierzchnia backendowa odpowiada zapisanej referencji Open Mercato i używa kanonicznej powłoki, komponentów, tokenów semantycznych oraz kompletnych stanów: loading, empty, error, conflict, klawiatura, dostępność, responsywność, tryb jasny i ciemny.
- [ ] Każda zmieniona ścieżka API i UI ma samodzielne pokrycie integracyjne, a bramka walidacji przechodzi.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | `AGENTS.md`, `.ai/guides/spec-delivery.md`, `.agents/skills/om-spec-writing/SKILL.md`, `.ai/specs/SPEC-000-template.md`; kontrakty zweryfikowane w `node_modules/@open-mercato/{core,enterprise}/src/modules/**` |
| Data models, APIs, events, UI, and tests are internally consistent | pass | Traceability pokrywa REQ-L-001…008, każdy z fazą, testem i kryterium |
| Every workflow completes end to end without a catch-all integration phase | pass | JL-001…JL-003; Phase L2 zamyka przepływ ręczny w całości, L3 i L4 to niezależne plastry |
| Platform-native reuse and extension points were chosen before custom code | pass | Mapa reuse: 12 pozycji reuse/extend wobec 3 app-own; każde app-own uzasadnione zweryfikowanym brakiem w installed |
| UI contracts identify references, canonical components, and theme/state coverage | pass | Trzy powierzchnie, każda z referencją installed; makieta zakładki „Przedmiar" |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Phases L1–L4 |
| Every blocking open question resolved | **fail** | Q-L-001 otwarte |

Verdict: **Blocked — Q-L-001**

## Open Questions

| ID | Question | Owner | Blocking? | Resolution / decision date |
|---|---|---|---|---|
| Q-L-001 | Czy pola custom (EAV) modułu `entities` są objęte szyfrowaniem w spoczynku? Od tego zależy, czy `site_address` może zostać custom fieldem na dealu, czy musi wrócić do kolumny we własnej tabeli. Do sprawdzenia w `entities` i `.ai/guides/modules/entities`. | użytkownik / weryfikacja w kodzie | **tak** — dane osobowe | pending |
| Q-L-002 | Czy pozycje materiałowe mają być wpisywane jako osobne wiersze zakresu, czy wliczone w cenę usługi w `catalog`? Założenie: osobne wiersze, bo daje podstawę do zamówienia materiału. | użytkownik | nie (wpływa na instrukcję dla kosztorysanta, nie na schemat) | pending |
| Q-L-003 | Czy wycena wygenerowana przez agenta ma wymagać strażnika blokującego wysyłkę w statusie `proposed`, czy wystarczy procedura? Założenie: procedura, bo strażnik oznacza mutation guard UMES na komendach `sales`. | użytkownik | nie (odwracalne, dotyczy Phase L4) | pending |

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Initial draft — wariant uproszczony: jeden moduł, trzy tabele, sprawa jako `CustomerDeal`, wycena jako `SalesQuote`, bez receptur i bez własnej encji wersji |
