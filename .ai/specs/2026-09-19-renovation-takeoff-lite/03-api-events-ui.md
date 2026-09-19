# 03 — Ścieżki, API, zdarzenia, UI i bezpieczeństwo

**Spec**: Przedmiar remontowy → wycena (wariant uproszczony)
**Date**: 2026-09-19
**Status**: Draft
**Indeks**: [README.md](./README.md) · **Poprzedni**: [02 — Architektura i dane](./02-architecture-and-data.md) · **Następny**: [04 — Testy i wdrożenie](./04-delivery.md)

> Trzy ścieżki użytkownika, kontrakty tras i komend, przepływy zdarzeń, powierzchnie UI, model zagrożeń.

## User Journeys

### Journey JL-001 — Wycena ręczna

1. Kosztorysant zakłada deal w `customers` (albo otwiera istniejący) i ustawia `deal_kind = 'renovation'`.
2. Na zakładce „Przedmiar" dodaje pomieszczenia z wymiarami i otworami. Komenda liczy `floor_area_m2`, `wall_area_net_m2` i `perimeter_m` i zapisuje je.
3. Dodaje pozycje zakresu: wybiera pomieszczenie, pozycję z katalogu przez picker i bazę ilości. Dla `wall_area` ilość podstawia się z geometrii; `manual` pozwala wpisać własną.
4. Klika „Generuj wycenę". `renovation_takeoff.quotes.generate` wycenia pozycje przez `catalogPricingService` i woła `sales.quotes.create` ze statusem `draft` i custom fieldem `deal_id`.
5. Przechodzi do dokumentu w `sales`, koryguje co trzeba, zmienia status na `sent` i wysyła istniejącym `api/quotes/send`.
6. Błędy: brak ceny dla pozycji → linia z zerem, flaga w wyniku generowania i ostrzeżenie w UI z linkiem do produktu. Konflikt optymistyczny na pomieszczeniu → 409 z podpowiedzią przeładowania. Pusty zakres → 422, wycena nie powstaje.

### Journey JL-002 — Kolejna wersja po negocjacji

1. Kosztorysant wraca do przedmiaru, zmienia wymiary albo zakres.
2. Klika „Generuj wycenę" ponownie. Powstaje **nowa** `SalesQuote` z własnym numerem i tym samym `deal_id`.
3. Lista wersji na zakładce sprawy pokazuje wszystkie wyceny deala z numerem, datą, sumą i statusem; najnowsza nieodrzucona jest oznaczona jako aktualna.
4. Poprzednia oferta pozostaje nietknięta — to jest ślad tego, co klient widział wcześniej.
5. Błędy: dwie równoległe generacje → obie się powiodą i dadzą dwa dokumenty; przeciwdziała temu `idempotencyKey` wyliczany z `(dealId, hash przedmiaru)`, który zwraca istniejącą wycenę zamiast tworzyć bliźniaczą.

### Journey JL-003 — Sprawa z maila i analiza przez agenta

1. Klient wysyła mail z rzutem na adres skrzynki. Most webhooka parsuje MIME, zapisuje pliki przez `StorageDriver` modułu `attachments`, przekazuje treść do `inbox_ops` i wiąże identyfikatory.
2. `inbox_ops` deduplikuje i uruchamia ekstrakcję; prompt zawiera `promptSchema` naszej akcji `start_renovation_takeoff`.
3. Operator akceptuje akcję w skrzynce. Silnik wykonania woła `renovation_takeoff.takeoff.start`, która tworzy deala przez `customers.deals.create`, zapisuje custom fields i **emituje `renovation_takeoff.started`**. Rola `inbox_ops` się kończy — nie wie, że istnieje warstwa AI.
4. `ProcessDefinition` z triggerem na `renovation_takeoff.started` startuje `WorkflowInstance`.
5. Krok `INVOKE_AGENT` (runtime OpenCode, bo tylko on obsługuje `input.__files`) czyta załączniki i zwraca `{ kind: 'research', data: { rooms: [...] } }` — **wymiary, nie powierzchnie**.
6. Aktywność workflow woła `renovation_takeoff.takeoff.rooms.upsert` dla każdego pomieszczenia. Powierzchnie liczy nasz kod.
7. Drugi krok `INVOKE_AGENT` proponuje pozycje katalogowe dla rozpoznanego zakresu. `DispositionService` decyduje: auto-approve przy przejściu wszystkich bramek albo `USER_TASK` i park na `WAIT_FOR_SIGNAL`.
8. Nasz efektor woła `executeProposal` z własną `actionCommandMap` i wykonuje `renovation_takeoff.takeoff.scope.upsert`, a na końcu `renovation_takeoff.quotes.generate` ze statusem `proposed`.
9. Kosztorysant otwiera wycenę w `sales`, przegląda, poprawia i przestawia status na `draft`, dalej jak JL-001 krok 5.
10. Błędy: agent nie odczytał wymiarów → `research` z pustą listą, workflow kończy się bez przedmiaru, sprawa czeka na człowieka. Akcja bez wpisu w `actionCommandMap` wraca jako `skipped`, nie błąd. Brak licencji enterprise → proces nie jest rejestrowany, ścieżki 1–3 i ręczne działają w pełni.

## API, Command, and Error Contracts

Trasy CRUD przez `makeCrudRoute` z per-metodowym `metadata` i eksportem `openApi`. Trasy akcji to własne strzeżone trasy komend. Każda edytowalna encja wystawia `updated_at`; klienty własnych aktualizacji wysyłają wersję i obsługują 409.

| Method / command | Path / ID | Auth and feature gate | Input | Success / event | Errors | Requirement IDs |
|---|---|---|---|---|---|---|
| `GET`/`POST`/`PUT`/`DELETE` | `/api/renovation-takeoff/rooms` | `renovation_takeoff.takeoff.view` / `.manage` | `{ dealId, name, lengthM, widthM, heightM }` | 201 + `renovation_takeoff.rooms.updated` | 400 (wymiar ≤ 0 lub > 999)/403/409 | REQ-L-001 |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/renovation-takeoff/openings` | `.view` / `.manage` | `{ roomId, kind, widthM, heightM, count }` | 201 + `renovation_takeoff.rooms.updated` | 400/403/409 | REQ-L-001 |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/renovation-takeoff/scope` | `.view` / `.manage` | `{ dealId, roomId?, catalogProductId, catalogVariantId?, quantityBasis, quantity?, unitCode? }` | 201 + `renovation_takeoff.scope.updated` | 400 (produkt spoza scope, `manual` bez ilości)/403/409 | REQ-L-002 |
| `POST` (command) | `/api/renovation-takeoff/start` → `renovation_takeoff.takeoff.start` | auth + `renovation_takeoff.takeoff.manage` + `customers.deals.manage` | `{ title, siteAddress?, customerEntityId?, sourceEmailId?, attachmentIds?, origin }` | 201 `{ dealId }` + `renovation_takeoff.started` | 400/403/409 | REQ-L-005 |
| `POST` (command) | `/api/renovation-takeoff/quotes/generate` → `renovation_takeoff.quotes.generate` | auth + `renovation_takeoff.quotes.generate` + `sales.quotes.manage` | `{ dealId, priceDate?, status?: 'draft' \| 'proposed', idempotencyKey? }` | 201 `{ quoteId, quoteNumber, lineCount, warnings }` + `renovation_takeoff.quote.generated` | 403/404/422 (pusty zakres)/502 (błąd komendy `sales`) | REQ-L-003, REQ-L-004 |
| `GET` | `/api/renovation-takeoff/quotes` | `.view` | `{ dealId }` | lista wycen deala z numerem, datą, sumą, statusem | 403/404 | REQ-L-004 |

**Generowanie wyceny — przebieg komendy.** Ładuje pozycje zakresu i pomieszczenia jednym zapytaniem; przelicza ilości dla baz innych niż `manual`; ładuje produkty i ceny katalogu **jednym zapytaniem per zbiór** i rozstrzyga ceny batchem przez `resolvePriceMany`; buduje tablicę linii (`kind: 'service'`, `quantity`, `quantityUnit`, `unitPriceNet`, `taxRate`, `catalogSnapshot`, `configuration: { roomId, scopeItemId }`); woła `sales.quotes.create` z całą tablicą w jednym wywołaniu; zapisuje custom fields `deal_id` i `takeoff_snapshot_at` na utworzonym dokumencie.

**Idempotencja:** `idempotencyKey` domyślnie wyliczany z `(dealId, hash pozycji zakresu i wymiarów)`. Powtórne wywołanie bez zmian w przedmiarze zwraca istniejącą wycenę zamiast tworzyć drugą — chroni przed podwójnym kliknięciem i przed powtórzeniem efektora.

**Komendy workflow-safe** (przez `registerWorkflowSafeCommands`, bez `defaultEnabled`):

| `commandId` | `requiredFeatures` |
|---|---|
| `renovation_takeoff.takeoff.rooms.upsert` | `renovation_takeoff.takeoff.manage` |
| `renovation_takeoff.takeoff.scope.upsert` | `renovation_takeoff.takeoff.manage` |
| `renovation_takeoff.quotes.generate` | `renovation_takeoff.quotes.generate` |

`renovation_takeoff.takeoff.start` **nie** jest workflow-safe — sprawę zakłada człowiek albo akcja inbox, nie agent.

**Kształt handlera.** Każda komenda implementuje `CommandHandler<TInput, TResult>` z `outputSchema` (bez niego context ledger `workflows` widzi wynik jako `unknown`), `isUndoable: true` z `undo`, `buildLog`, `captureAfter`, a komendy tworzące `redo` przez `makeCreateRedo`. Undo czyta kopertę wyłącznie przez `extractUndoPayload(logEntry)`.

**Efektor propozycji.** `commands/dispose.ts` zapisuje werdykt, ale **nie wykonuje** akcji — `executeProposal` to opcjonalny helper wymagający `actionCommandMap` od wywołującego. Mapa żyje w `renovation_takeoff/lib/proposalEffector.ts`. Akcja bez wpisu wraca jako `skipped`, nie błąd, więc każdy typ akcji agenta musi mieć wiersz w mapie i test, że go ma. Słownik akcji sprawdzany ponownie tuż przed efektem.

**Wstrzykiwanie propozycji do testów.** Ścieżkę „propozycja → akceptacja → efektor → komenda" testujemy bez agenta: `agent_orchestrator.runs.create` → `agent_orchestrator.proposals.create` (`source: 'runtime'`, `workflowInstanceId: null`) → `POST /api/agent_orchestrator/proposals/:id/dispose`. Zasady: `reason` obowiązkowy przy `edited` i `rejected`, `payload` przy `edited`, `selectedOptionId` przy `approved`/`edited` i zabroniony przy `rejected`.

## Events, Jobs, Notifications, and Cross-Module Flows

| Trigger | Producer | Consumer | Side effect | Retry / idempotency |
|---|---|---|---|---|
| `renovation_takeoff.started` | `renovation_takeoff` (komenda, nie encja) | `ProcessDefinition` z triggerem `event` | start `WorkflowInstance` | idempotencja po `(definition, key)` przed utworzeniem instancji; `maxConcurrentInstances` ogranicza równoległość |
| `renovation_takeoff.rooms.updated` | `renovation_takeoff` | subscriber przeliczający ilości pozycji o bazie innej niż `manual` | aktualizacja `TakeoffScopeItem.quantity` | idempotentne przeliczenie z bieżącego stanu |
| `renovation_takeoff.quote.generated` | `renovation_takeoff` | aktualizacja `CustomerDeal.value_amount` komendą `customers.deals.update`; powiadomienie właściciela | forecast w CRM | dedup po `quoteId` |
| `catalog.price.updated` | `catalog` | subscriber flagujący wyceny `draft`/`proposed` starsze niż zmiana | flaga „cennik się zmienił" jako custom field na wycenie | `sent` i `accepted` nietykane |
| `customers.deal.deleted` | `customers` | subscriber modułu | soft delete pomieszczeń i zakresu deala | idempotentne |
| `inbox_ops.email.received` | `inbox_ops` | istniejący `extractionWorker` | propozycja z akcją `start_renovation_takeoff` | dedup po `messageId`/`contentHash` |

**Trigger procesu** deklaruje:

```ts
triggers: [{
  kind: 'event',
  eventPattern: 'renovation_takeoff.started',
  priority: 0,
  enabled: true,
  config: {
    filterConditions: [{ field: 'hasAttachments', operator: 'eq', value: true }],
    contextMapping: [
      { targetKey: 'dealId', sourceExpression: 'payload.dealId' },
      { targetKey: 'attachmentIds', sourceExpression: 'payload.attachmentIds', defaultValue: [] },
    ],
    maxConcurrentInstances: 5,
  },
}]
```

Ładunek `renovation_takeoff.started` niesie `dealId`, `origin`, `hasAttachments`, `attachmentCount`, `attachmentIds` — bez tych pól `filterConditions` nie ma po czym filtrować, a bez `contextMapping` wykonanie wywołane zdarzeniem nie ma żadnego wejścia. Obie listy są tablicami obiektów, nie mapami.

Zachowanie przy nieobecnym module opcjonalnym: bez `agent_orchestrator` proces nie jest rejestrowany, akcja inbox i ścieżka ręczna działają. Bez `inbox_ops` plik `inbox-actions.ts` nie ładuje się, moduł działa bez wejścia mailowego.

## UI and Interaction Contracts

Tabele to `DataTable`, formularze CRUD to `CrudForm`, odczyty przez współdzielone helpery API. Referencje do rekordów renderują się jako kontrolki wyboru z nazwami: pozycja katalogowa przez picker `catalog` (wzorzec `sales/components/documents/LineItemDialog.tsx`), klient przez picker `customers`. Surowe UUID wyłącznie w ładunkach API.

| Surface / route | Purpose and primary actions | Data source / mutations | Closest installed reference | Canonical components | Required states | Requirement IDs |
|---|---|---|---|---|---|---|
| Zakładka „Przedmiar" na `/backend/customers/deals/[id]` | Pomieszczenia, otwory, wyliczone powierzchnie, zakres prac; akcja „Generuj wycenę" | `/api/renovation-takeoff/*` | `customers` detal deala + `sales/components/documents/LineItemDialog.tsx` | `DataTable` ×2, `CrudForm` w dialogu, picker katalogu | loading, empty, error, conflict, warning (powierzchnia ≤ 0, brak ceny), permission denied | REQ-L-001, REQ-L-002, REQ-L-003 |
| Zakładka „Wyceny" na `/backend/customers/deals/[id]` | Lista wycen deala: numer, data, suma, status, wskazanie aktualnej; link do dokumentu w `sales` | `GET /api/renovation-takeoff/quotes` | lista dokumentów `sales` | `DataTable` | loading, empty, error | REQ-L-004 |
| Widget na `/backend/sales/quotes/[id]` | Panel „Przedmiar": z jakiej sprawy, ile pomieszczeń, suma powierzchni, data snapshotu | enricher `_takeoff` + widget injection | `eudr/data/enrichers.ts` | widget host `sales` | loading, empty (wycena spoza przedmiaru), error (fallback `null`) | REQ-L-003 |

Obie zakładki wchodzą na istniejącą stronę deala przez injection — nie budujemy własnej sekcji nawigacji ani własnej listy spraw. To jest bezpośrednia konsekwencja rezygnacji z własnego nagłówka.

### Zakładka „Przedmiar"

```text
┌────────────────────────────────────────────────────────────┐
│ Przedmiar                                  [+ Pomieszczenie]│
│ Suma podłóg: {x} m²    Suma ścian netto: {y} m²            │
├────────────────────────────────────────────────────────────┤
│ Pomieszczenia (DataTable)                                  │
│  Nazwa | Dł. | Szer. | Wys. | Podłoga m² | Ściany m² | ⋯   │
│  Salon | 4,2 | 3,6   | 2,7  | 15,1200    | 37,9200   | ⋯   │
│    └ Otwory: okno 1,4×1,5 ×2                               │
├────────────────────────────────────────────────────────────┤
│ Zakres prac (DataTable)                       [+ Pozycja]  │
│  Pomieszczenie | Pozycja katalogowa | Baza     | Ilość|Jedn.│
│  Salon         | Malowanie 2×       | ściany   | 37,92| m2  │
│  Salon         | Farba lateksowa    | ręczna   |  9,10| l   │
├────────────────────────────────────────────────────────────┤
│ [Generuj wycenę]                                           │
└────────────────────────────────────────────────────────────┘
```

Dwie linie w przykładzie pokazują cenę rezygnacji z receptur: farbę trzeba dodać ręcznie i samemu policzyć 9,10 l.

- **Behavior:** zmiana wymiarów przelicza ilości pozycji o bazie innej niż `manual` i pokazuje to jako komunikat; nadpisanie ilości przełącza bazę na `manual` i przestaje śledzić geometrię; usunięcie pomieszczenia z potwierdzeniem kasuje jego otwory i pozycje zakresu; konflikt optymistyczny zwraca 409 z przyciskiem przeładowania bez utraty otwartego dialogu.
- **Responsive and accessibility:** kolejność focusu zgodna z układem; wyliczone powierzchnie z `aria-live="polite"`; jednostki czytane pełnym słowem.
- **Localization:** namespace `renovation_takeoff`; liczby i jednostki przez formatter lokalizacji (przecinek dziesiętny dla `pl`).
- **Design-system and theming:** wyłącznie tokeny semantyczne; ostrzeżenia przez token stanu, nie zapisany kolor; weryfikacja w trybie jasnym i ciemnym oraz przy zawężonym oknie.

Implementacja powierzchni backendowych wywołuje `om-backend-ui-design` i czyta `.ai/guides/backend-ui.md`.

## Security, Privacy, and Compliance

- **Authorization:** feature gates z `acl.ts` modułu, deklarowane w `metadata` tras i `requiredFeatures` komend workflow-safe. Zero sprawdzeń po nazwie roli. Nowe features w `setup.ts` `defaultRoleFeatures` + `yarn mercato auth sync-role-acls`.
- **Tenant isolation:** każdy odczyt i zapis filtruje po `tenantId` + `organizationId` z kontekstu auth. Odczyty encji `catalog` niosą ten sam filtr. Odczyt deala przed zapisem przedmiaru weryfikuje, że deal należy do scope — inaczej obcy `dealId` w ładunku przypina przedmiar do cudzej sprawy.
- **Sensitive data:** `site_address` żyje w custom fieldzie na dealu. Szyfrowanie pól EAV nie jest potwierdzone — **Q-L-001**, otwarte i blokujące dla danych osobowych. Do rozstrzygnięcia: albo pole EAV jest szyfrowane, albo adres obiektu wraca do kolumny we własnej tabeli.
- **Abuse and failure modes:**
  - *Podpięcie przedmiaru pod cudzy deal* — walidacja przynależności deala do scope przy każdym zapisie; test międzytenantowy obowiązkowy.
  - *Wstrzyknięcie przez mail* — treść maila i wynik agenta to dane, nigdy instrukcje; ładunek akcji inbox przechodzi walidację Zod, pola spoza schematu odrzucane.
  - *Replay webhooka mostu* — podpis wobec sekretu per tenant z fallbackiem na globalny; dedup po `messageId` i `contentHash` w `inbox_ops`.
  - *Wyjście sieciowe agenta* — `agent_orchestrator.web_search` i `web_fetch` pozostają wyłączone.
  - *Nieautoryzowany zapis agenta* — `agentNoBypassSubscriber` plus katalog workflow-safe bez `takeoff.start`.
  - *Podwójne generowanie wyceny* — `idempotencyKey` z hasha przedmiaru.
  - *Wysłanie wersji roboczej do klienta* — patrz Risks; w tym wariancie mitygacja jest proceduralna i przez status, nie przez strażnika.
