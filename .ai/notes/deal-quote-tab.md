# Tab „quote'y" na deal detail — ustalenia z researchu

Notatka z sesji researchowej. Wszystko poniżej zweryfikowane w kodzie (`node_modules/@open-mercato/core` @ zainstalowana wersja + `src/`), nie z pamięci. Nic z docelowej funkcjonalności nie jest zaimplementowane; sonda osadzania, którą to potwierdzono, została usunięta.

## Cel

Na stronie detalu deala (`customers`) pokazać tab linkujący do powiązanych quote'ów / orderów (`sales`). Wymaganie: najmniej inwazyjnie.

## 1. Host injection — istnieje

`detail:customers.deal:tabs`

- `customers/backend/customers/deals/[id]/hooks/useDealInjectedTabs.tsx:28` — `useInjectionWidgets('detail:customers.deal:tabs')`, filtruje `placement.kind === 'tab'`, label z `placement.groupLabel`, sort po `priority` malejąco.
- `customers/backend/customers/deals/[id]/page.tsx:102,664` — renderuje taby w pasku; przełączanie przez `?tab=<groupId>`.

Kontekst dostarczany widgetowi (`hooks/useDealMutationContext.ts`):
```ts
{ formId, dealId, resourceKind: 'customers.deal', resourceId, data, retryLastMutation }
```
`data` to pełny `DealDetailPayload`.

**Haczyk:** `customers/extension-points.ts:30-32` deklaruje tylko `dealHeader`, `dealStatusBadges`, `dealFooter`. `:tabs` NIE jest w `extension-points.ts` ani w `.ai/guides/modules/customers/umes-hosts.md` — brak statusu FROZEN. Kod go czyta, ale kontrakt niegwarantowany między wersjami. Do oznaczenia `HACK(hackathon)`.

Wzorzec w repo (kierunek odwrotny) — `src/modules/example/widgets/injection-table.ts:105`; uwaga, moduł `example` jest **wyłączony**, więc to kod do czytania, nie do oglądania (patrz sekcja o sondzie):
```ts
'sales.document.detail.quote:tabs': [
  { widgetId: 'example.injection.sales-todos', kind: 'tab', groupLabel: 'example.salesTodos.tabLabel', priority: -10 },
],
```
Uwaga na kształt wpisu: `ModuleInjectionSlot` = pola placement (`kind`, `groupId`, `groupLabel`) **płasko** obok `widgetId`/`priority`, nie w zagnieżdżonym `placement` (`shared/src/modules/widgets/injection.ts:479`).

**Haczyk 2 — `groupLabel` to tekst, nie klucz.** Host deala jako jedyny z trzech nie przepuszcza etykiety przez `t()`:

| host | rozwiązanie etykiety | efekt |
|---|---|---|
| `customers` person — `people-v2/[id]/page.tsx:312` | `t(groupLabel, groupLabel)` | tłumaczy |
| `sales` dokumenty — `sales/backend/sales/documents/[id]/page.tsx:4016` | `t(groupLabel, metadata.title)` | tłumaczy |
| `customers` **deal** — `useDealInjectedTabs.tsx:38` | `groupLabel ?? metadata.title ?? tabId` | **brak `t()`** |

Pasek tabów też nie ratuje: `customers/components/detail/DealDetailTabs.tsx:108` przepuszcza `tab.label` żywcem, podczas gdy taby wbudowane (`:67-94`) idą przez `t()`. Klucz podany w `groupLabel` renderuje się więc dosłownie.

Obejścia nie ma czystego: tabela injekcji musi być statycznym literałem (obliczany export publikuje zero kontrybucji), a paska tabów nie da się nadpisać, bo `extension-points.ts` go nie wystawia. Zostaje wpisanie gotowego tekstu w `groupLabel` — kosztem tego, że etykieta nie jest lokalizowana. `yarn i18n:check-hardcoded` tego nie wyłapuje, bo nie skanuje tabel injekcji. Ciało widgetu jest nietknięte, tłumaczy się normalnie przez `useT`.

Pliki po stronie app: `src/modules/<id>/widgets/injection/<slug>/widget.ts` + `widget.client.tsx`, mapowanie w `widgets/injection-table.ts`. Referencja: `customers/widgets/injection/ai-deal-detail-trigger/`.

## 2. Połączenie deal ↔ quote — NIE ISTNIEJE

- `sales_quotes` (`sales/data/entities.ts:822`) nie ma `deal_id`. Ma `customer_entity_id`, `customer_contact_id`, `metadata` jsonb, `custom_field_set_id`.
- `CustomerDeal` (`customers/data/entities.ts:313+`) nie ma kolumny `metadata`.
- W całym `src/` żaden kod nie tworzy `SalesQuote`.
- Akcja inboxowa `create_quote` (`src/modules/rfq_intake/inbox-actions.ts`) mimo nazwy tworzy **deal** — zwraca `createdEntityType: 'customer_deal'`. Jest tam `HACK(hackathon)`: nazwa typu kłamie, bo `extractedActionSchema` (`inbox_ops/data/validators.ts:183`) to zamknięty `z.enum` używany jako structured-output schema LLM-a, więc `create_rfq` nigdy nie mógłby zostać zaproponowany.
- Krok workflow `'Mark the case as being quoted'` przesuwa tylko etap lejka, nie tworzy quote'a.

Wniosek: tab nie ma jeszcze czego pokazywać. Najpierw tworzenie quote'a + zapis powiązania.

## 3. Komenda przesuwania etapu — co faktycznie łączy

`rfq_intake.deal.advance` (`src/modules/rfq_intake/commands/pipeline.ts:31`), etykieta `rfq_intake.workflows.commands.deal.advance` = „RFQ: przesuń sprawę na etap lejka" (`src/i18n/pl.json:604`). To komenda app-owned, nie installed OM.

Input: `{ tenantId, organizationId, dealId, stage }`, gdzie `stage` ∈ `RFQ_STAGE_KEYS` (`new`/`quoting`/`review`/`sent`/`won`/`lost`, `src/modules/rfq_intake/lib/pipeline.ts`).

Rozwiązuje **stage key → per-tenant `pipelineStageId`** (bo id etapu to wiersz per tenant, graf może go nazwać tylko symbolicznie), potem woła installed `customers.deals.update`. Quote w niej nie występuje w ogóle.

Installed OM nie ma dedykowanej komendy „move stage" — są `customers.deals.create/update/delete` + AI tool `customers.update_deal_stage`.

### Jak komenda wie, który deal

Nic nie odgaduje — `dealId` przychodzi jawnie, przeniesiony przez łańcuch:

1. `inbox-actions.ts` → `customers.deals.create` → `{ createdEntityId: dealId, createdEntityType: 'customer_deal' }`
2. event `inbox_ops.action.executed` niesie `createdEntityId`
3. `src/modules/rfq_intake/subscribers/start-rfq-analysis.ts` — `const dealId = trimmed(payload.createdEntityId)!`, buduje `RfqAnalysisInput`
4. `src/modules/rfq_intake/lib/startProcess.ts:87` — `agent_orchestrator.processes.startExecution` z `input` jako start context, `sourceEntityType: 'customer_deal'`, `sourceEntityId: input.dealId`, `idempotencyKey: 'rfq_intake.analysis:<dealId>'`
5. `src/modules/rfq_intake/workflows.ts:73` (i `:13`, `:172`) — `input: { dealId: '{{context.dealId}}', stage: 'quoting', ... }`; silnik podstawia ze start contextu
6. komenda → `customers.deals.update` z `id: input.dealId`; tam `findOneWithDecryption` + `ensureTenantScope`/`ensureOrganizationScope` na znalezionym rekordzie (scope z inputu nie jest brany na wiarę)

Referencję trzyma **egzekucja procesu** (`sourceEntityId`), nie deal. Deal nie ma referencji zwrotnej ani do procesu, ani do quote'a.

## 4. `metadata` na sales docs — dlaczego odpada

Zapis: `sales.quotes.create/update` przyjmują `metadata` (`sales/commands/documents.ts:605`), przypisanie w `:1172-1173` to **pełna podmiana**, nie merge → dopisanie klucza wymaga read-modify-write.

Odczyt: `sales/api/documents/factory.ts` trzyma `'metadata'` w `commonFields`, ale również w `detailOnlyProjectionFields` (razem z `*_snapshot`). `gridFields` = `listFields` minus te pola. Pełna projekcja tylko przy `?id=<jeden id>` (detal idzie tym samym route'em z filtrem `id`). Listowanie **nie zwraca `metadata`** — świadoma decyzja wydajnościowa (#2233).

Filtry listy: `id`, `number`, `customerId` (`customer_entity_id`), `channelId`, `status`, daty, `lineRange` (`factory.ts:125-157`). Po `metadata` ani po custom fieldach — nie ma.

Skutek: „pobierz quote'y tego deala" przez `metadata.dealId` = lista po `customerId` → rekordy bez metadata → dociąganie każdego po `?id=` → filtr w pamięci. N+1.

## 5. Rekomendacja — custom field na dealu

Odwrócić kierunek: trzymać referencję po stronie deala.

Odczyt jest darmowy — deal detail już zwraca custom fieldy:
- `customers/api/deals/[id]/route.ts:702-719` — `loadCustomFieldValues` dla `E.customers.customer_deal`, potem `normalizeCustomFieldResponse`
- `customers/backend/customers/deals/[id]/hooks/types.ts:55` — `customFields: Record<string, unknown>` w `DealDetailPayload`
- payload trafia do widgetu jako `data`

Zapis jednym wywołaniem istniejącej komendy — `customers.deals.update` parsuje custom fieldy (`customers/commands/deals.ts:755` → `parseWithCustomFields`, dalej `runCrudCommandWrite({ customFields: custom })`). Klucze rozpoznawane m.in. z `customFields: {...}` / `customValues: {...}` (`shared/src/lib/crud/custom-fields.ts:190`).

Definicja pola nie jest wymagana do zapisu: `validateCustomFieldValuesServer` (`entities/lib/validation.ts:5`) ma `rejectUndeclaredKeys` domyślnie `false` → nieznany klucz przechodzi i się zapisuje. Definicja potrzebna dopiero, żeby pokazać pole w formularzu deala albo po nim filtrować.

Bilans: zero własnych encji, zero migracji, zero nowego API route'u. Widget czyta `data.customFields.<key>` z payloadu, który już ma, i renderuje link do `/backend/sales/quotes/<id>`. Bez fetcha.

Ograniczenie: jedno pole = jeden quote; przy wielu trzymać tablicę id-ków w tym samym cf. Kierunek odwrotny (quote → deal) dalej nieobsłużony.

### Odrzucone alternatywy

- **Własna encja linkująca** (`dealId`, `quoteId`, scope) + własny endpoint — zgodne z `.ai/guides/extensions.md` („scalar host ID + snapshot"), przeżyje zmiany w `sales`, obsłuży oba kierunki i 1:N. Koszt: migracja + route. Jedyna opcja skalująca się do listy i do kierunku quote → deal.
- **Entity extension** (`data/extensions.ts`) — odpada. `src/modules/example/data/extensions.ts` ma NOTE: deklaracja jest declaration-only, hybrydowy query engine ignoruje `includeExtensions`, join nie dodaje projekcji ani aliasu filtrowalnego.
- **`metadata.dealId` na quote** — odpada, patrz pkt 4.

## Sonda osadzania — wykonana i usunięta

Moduł `src/modules/deal_quote_tab/` istniał tymczasowo i **został skasowany** po potwierdzeniu tezy. Co udowodnił: `yarn generate` podnosi widget z nowego modułu app bez ręcznej rejestracji (trafia do `injection-widgets.generated.ts`, `injection-tables.generated.ts`, `modules.i18n.*.generated.ts`), host renderuje tab i przekazuje kontekst. Przy okazji wyszedł Haczyk 2 wyżej.

Uwaga dla przyszłej sesji: `example` i `rfq_intake` **nie są włączone** przy obecnym `.env` (`OM_ENABLE_ENTERPRISE_MODULES=false`), więc wzorzec `sales.document.detail.quote:tabs` z `src/modules/example/` to w tej apce martwy kod. Jedyny bezwarunkowo włączony moduł app to `catalog_seed`.

Dalszy ciąg nie jest już przedmiotem tej notatki — projekt i plan wdrożenia żyją w `.ai/specs/2026-09-19-deal-document-links.md` oraz `docs/superpowers/plans/2026-09-19-deal-document-links.md`, na branchu `feat/deal-document-links`.

## Kolejność prac

1. Tworzenie `SalesQuote` w łańcuchu RFQ (dziś nie istnieje).
2. Zapis referencji na dealu przez `customers.deals.update` + `customFields`.
3. Rozbudowa sondy (`deal_quote_tab`) o czytanie `data.customFields` i link do `/backend/sales/quotes/<id>` — samo osadzenie już działa.

## Otwarte

- Jeden quote na deal czy wiele? Decyduje między cf a encją linkującą.
- Czy potrzebny kierunek quote → deal (tab „deal" na quote detail). Jeśli tak, cf nie wystarczy.
- Czy `:tabs` zostanie podniesiony do zadeklarowanego hosta upstream, czy zostaje jako `HACK(hackathon)`.
- Czy zgłosić upstream brak `t()` w `useDealInjectedTabs` (person i sales robią to poprawnie), czy trzymać literał w `groupLabel` do końca hackathonu.

## Zasady projektu istotne dla tej pracy

- Route wg `AGENTS.md`: `umes` + `backend-ui` (wstrzyknięcie własnego UI w installed surface) + `module-data` przy własnych danych.
- Guides do wczytania: `.ai/guides/extensions.md`, `.ai/guides/backend-ui.md`; skille `om-system-extension`, `om-backend-ui-design`.
- Po zmianie plików discovery / `injection-table.ts`: `yarn generate`, potem `yarn typecheck && yarn lint`.
- Lokalizacja stringów obowiązkowa (`src/i18n/pl.json`), zero hardkodu.
- Skróty hackathonowe oznaczać inline jako `// HACK(hackathon): <co, czemu, co się psuje>`.
