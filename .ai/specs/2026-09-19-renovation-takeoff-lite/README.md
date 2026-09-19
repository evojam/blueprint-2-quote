# Przedmiar remontowy → wycena (wariant uproszczony)

**Date**: 2026-09-19
**Status**: Draft
**Verdict**: Blocked — Q-L-001

Wariant minimalny aplikacji do szacowania remontów. Istnieje też opracowanie pełne — z warstwą receptur i osobnym kosztorysem — które nie jest częścią tego repozytorium; oba opisują dwa poziomy ambicji tego samego produktu, a do implementacji wchodzi jeden, wybrany świadomie. Porównanie w sekcji „Czym różni się od wariantu pełnego".

## TLDR

**Jeden moduł app-owned, trzy tabele.** Sprawa remontowa to `CustomerDeal` z `customers`. Wycena to `SalesQuote` z `sales`. Własne są wyłącznie dane, których nie ma nigdzie w installed: pomieszczenia, otwory i lista robót.

Kosztorysant wprowadza wymiary, dobiera pozycje wprost z `catalog`, klika „Generuj wycenę" i dostaje dokument z ilościami, cenami, VAT-em i sumami. Ścieżka mailowa i agentowa jak w wariancie pełnym, tylko proponuje pozycje katalogowe zamiast receptur.

## Dokumenty

| # | Plik | Zawartość |
|---|---|---|
| 00 | [Przepływ krok po kroku](./00-flow-walkthrough.md) | **dokument poglądowy dla zespołu** — 18 kroków, diagram sekwencji, cztery mechanizmy komunikacji, **trzy przekształcenia M1–M3 i dwa warianty liczenia powierzchni**; zacznij od niego na spotkaniu |
| 01 | [Przegląd i zakres](./01-overview.md) | TLDR, problem, miary, REQ-L-001…008, **non-goals**, decyzje, droga rozbudowy do wariantu pełnego |
| 02 | [Architektura i model danych](./02-architecture-and-data.md) | słownik domenowy, uprawnienia, mapa reuse/own, diagram, trzy encje, custom fields na installed |
| 03 | [Ścieżki, API, zdarzenia, UI](./03-api-events-ui.md) | JL-001…JL-003, kontrakty tras i komend, efektor, zdarzenia, powierzchnie UI, model zagrożeń |
| 04 | [Testy i wdrożenie](./04-delivery.md) | TL-001…TL-014, cztery fazy, traceability, rollout, ryzyka, kryteria akceptacji, pytania otwarte |

## Mapa sekcji szablonu

| Sekcja `SPEC-000-template.md` | Plik |
|---|---|
| TLDR, Problem Statement, Overview and Success Measures, Goals, Non-goals, Proposed Solution | 01 |
| Domain Vocabulary and Business Rules, Users Permissions and Scope, Reuse and Ownership Map, Architecture and Data Flow, Data Models | 02 |
| User Journeys, API Command and Error Contracts, Events Jobs Notifications and Cross-Module Flows, UI and Interaction Contracts, Security Privacy and Compliance | 03 |
| Integration Coverage, Implementation Phases, Requirement Traceability, Rollout Migration and Rollback, Risks and Tradeoffs, Acceptance Criteria, Final Compliance Report, Open Questions, Changelog | 04 |

## Czym różni się od wariantu pełnego

| Wymiar | Wariant pełny | Wariant uproszczony |
|---|---|---|
| Moduły app-owned | 2 (`service_recipes`, `renovation_cases`) | **1** (`renovation_takeoff`) |
| Własne tabele | 7 | **3** |
| Nagłówek sprawy | własny `RenovationCase` z opcjonalnym `dealId` | `CustomerDeal` + custom fields |
| Receptury i normy nakładów | `ServiceRecipe` + kroki z nakładem na jednostkę | **brak** — zakres wskazuje pozycję katalogową wprost |
| Kosztorys wewnętrzny | `EstimateVersion` + linie, oddzielony od oferty | **brak** — wycena to od razu `SalesQuote` |
| Wersjonowanie | `EstimateVersion.versionNo` + łańcuch pochodzenia | kolejne `SalesQuote` pod jednym dealem |
| Niezmienność propozycji AI | `proposed` read-only, egzekwowane w komendzie | status `proposed` bez strażnika |
| Fazy | 6 | **4** |
| Testy | 19 | 14 |

## Co tracisz

Jedna rzecz decyduje, czy ten wariant wystarczy: **materiał nie dolicza się sam**. Pozycja „malowanie ścian 37,92 m²" jest jedną linią; farbę, grunt i taśmę kosztorysant dodaje ręcznie albo ma je wliczone w cenę usługi w katalogu.

Jeśli Twój cennik trzyma materiał w cenie usługi — ten wariant wystarczy i oszczędza cztery tabele oraz dwie fazy. Jeśli musisz wiedzieć, ile farby zamówić — potrzebujesz receptur i wariant pełny jest właściwy.

Pozostałe straty (oferta = kosztorys, brak niezmiennej propozycji, numeracja wersji) są opisane w [Non-goals](./01-overview.md#non-goals) i [Risks](./04-delivery.md#risks-and-tradeoffs).

## Fazy w skrócie

1. **L1 — Przedmiar** — pomieszczenia, otwory, zakres; zakładka na stronie deala
2. **L2 — Generowanie wyceny** — wycena z katalogu → `sales.quotes.create`; **po tej fazie produkt zastępuje arkusz**
3. **L3 — Wejście mailowe** — most załączników, akcja inbox, własne zdarzenie
4. **L4 — Agent** — efektor i harness najpierw, agenci potem; wymaga enterprise

Fazy L1–L2 nie zależą od enterprise ani od poczty.

## Co blokuje gotowość

**Q-L-001** — czy pola custom (EAV) są szyfrowane w spoczynku. Od tego zależy, czy `site_address` może zostać custom fieldem na dealu, czy musi wrócić do kolumny we własnej tabeli — a to jest jedyne miejsce, w którym ten wariant dotyka danych osobowych. Q-L-002 i Q-L-003 mają zapisane założenia i nie blokują.
