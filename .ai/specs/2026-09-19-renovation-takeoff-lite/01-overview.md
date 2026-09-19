# 01 — Przegląd i zakres

**Spec**: Przedmiar remontowy → wycena (wariant uproszczony)
**Date**: 2026-09-19
**Status**: Draft
**Indeks**: [README.md](./README.md) · **Poprzedni**: — · **Następny**: [02 — Architektura i dane](./02-architecture-and-data.md)

> Po co ten wariant, co świadomie z niego wypadło i jaka jest droga rozbudowy do wersji pełnej.

## TLDR

Najcieńsza wersja aplikacji do szacowania remontów na Open Mercato: **jeden moduł app-owned, trzy tabele**. Sprawa remontowa to `CustomerDeal` z modułu `customers`. Wycena to `SalesQuote` z modułu `sales`. Własne są wyłącznie te dane, których nie ma nigdzie w installed: pomieszczenia, otwory i lista robót.

Kosztorysant wprowadza wymiary pomieszczeń, dobiera pozycje wprost z `catalog`, klika „Generuj wycenę" i dostaje `SalesQuote` z policzonymi ilościami, cenami, VAT-em i sumami. Ścieżka mailowa i agentowa działa tak samo jak w wariancie pełnym, tylko proponuje pozycje katalogowe zamiast receptur.

Brak warstwy receptur i norm jest **świadomą rezygnacją**, nie uproszczeniem do nadrobienia w implementacji. Konsekwencje opisane w Non-goals.

## Problem Statement

Szacowanie remontu żyje w arkuszach. Konkretne skutki, te same co w wariancie pełnym: cennik w kopiach, przedmiar liczony kalkulatorem bez śladu, brak historii wersji oferty, dokumentacja zostaje w mailu.

Wariant uproszczony bierze na celownik dwa z nich — **przedmiar bez śladu** i **cennik w kopiach** — a resztę zostawia na później. Powód: to jedyne dwa, których installed Open Mercato nie pokrywa wcale, i jednocześnie te, które da się zamknąć trzema tabelami.

Pozostałe problemy są tu adresowane cudzymi mechanizmami: historia wersji to wiele `SalesQuote` pod jednym dealem, dokumentacja z maila to `attachments` + `inbox_ops`, lejek i timeline to `customers`.

## Overview and Success Measures

- **Primary outcome:** oferta na remont mieszkania powstaje w mniej niż 30 minut, z zapisanym przedmiarem, z którego wynikają ilości.
- **Leading indicators:** odsetek ofert wygenerowanych z przedmiaru (a nie wpisanych ręcznie w `sales`); liczba pozycji na wycenie pochodzących wprost z katalogu; mediana liczby wersji oferty na deal.
- **Baseline:** unknown — plan pomiaru: pierwsze 20 spraw równolegle w arkuszu i w systemie, porównanie czasu i sum.
- **Market / product reference:** Buildertrend i Houzz Pro (proces ofertowania wykonawcy: obmiar → pozycje → oferta → akceptacja). Przyjmujemy ich model „obmiar rodzi pozycje oferty". Odrzucamy katalogi normowe typu Sekocenbud i Norma PRO — to jest dokładnie warstwa, którą ten wariant pomija.

## Goals

- **REQ-L-001** — Kosztorysant zakłada sprawę remontową jako `CustomerDeal`, wprowadza pomieszczenia z wymiarami i otworami i otrzymuje policzone powierzchnie podłóg i ścian netto.
- **REQ-L-002** — Kosztorysant dobiera do pomieszczenia pozycje wprost z `catalog`; ilość podpowiada się z geometrii i jest nadpisywalna.
- **REQ-L-003** — Jedna komenda generuje `SalesQuote` z pozycjami wycenionymi przez `catalogPricingService` w kontekście klienta, ilości i daty, z pełnym snapshotem ceny na linii.
- **REQ-L-004** — Kolejne wersje oferty powstają jako kolejne `SalesQuote` pod tym samym dealem, z widoczną listą wersji i wskazaniem aktualnej.
- **REQ-L-005** — Mail z dokumentacją zakłada sprawę: załączniki trafiają do `attachments`, treść do `inbox_ops`, akcja inbox tworzy deala i emituje nasze zdarzenie.
- **REQ-L-006** — Agent analizuje załączoną dokumentację i zwraca wymiary pomieszczeń jako wynik `research`, z których nasz kod liczy powierzchnie.
- **REQ-L-007** — Agent proponuje pozycje katalogowe do rozpoznanego zakresu; propozycja przechodzi dyspozycję, a zapis idzie przez zarejestrowaną workflow-safe command.
- **REQ-L-008** — Izolacja `tenantId` + `organizationId` fail-closed na każdym odczycie i zapisie, łącznie z odczytami `catalog` i zapisami do `sales` i `customers`.

## Non-goals

Najważniejsza sekcja tego dokumentu. Każda pozycja to świadoma strata, nie przeoczenie.

- **Receptury i normy nakładów.** Pozycja „malowanie ścian 37,92 m²" jest jedną linią. Farba, grunt i taśma **nie doliczą się same** — kosztorysant musi dodać je jako osobne pozycje zakresu albo mieć je wliczone w cenę usługi w katalogu. To jest największa funkcjonalna strata wobec wariantu pełnego i jedyny powód, dla którego ten wariant może się nie nadać.
- **Osobny dokument kosztorysu wewnętrznego.** Wycena dla klienta i kalkulacja to ten sam `SalesQuote`. Klient widzi rozbicie na pozycje, które wpisał kosztorysant. Agregacja „pokaż jedną linię zamiast czterech" nie istnieje.
- **Niezmienna wersja propozycji.** `sales` nie zna wersji read-only. Oferta wygenerowana przez agenta jest zwykłym `SalesQuote` w statusie `proposed` i technicznie daje się edytować oraz wysłać. Mitygacja proceduralna i przez status, nie przez strażnika — patrz Risks.
- **Własny nagłówek sprawy.** Brak `RenovationCase`. Dane sprawy, których `CustomerDeal` nie ma, idą w custom fields.
- **Rozróżnienie kosztu zakupu od ceny sprzedaży**, marża, rekurencja czegokolwiek, harmonogram robót, portal klienta, rozpoznawanie CAD/BIM.

## Proposed Solution

Trzy warstwy, z czego dwie są cudze.

**Sprawa — `customers`.** `CustomerDeal` niesie tytuł, właściciela, etap lejka, wartość, prawdopodobieństwo, wygraną i przegraną, timeline aktywności oraz powiązania z osobą i firmą. Dokładamy do niego custom fields przez `ce.ts`: `deal_kind` (dyskryminator `renovation`), `site_address`, `source_email_id`, `attachment_ids`, `workflow_instance_id`.

**Wycena — `sales`.** `SalesQuote` niesie numerację, statusy, sumy, VAT, wysyłkę, akceptację i konwersję na zlecenie. Linia ma `quantity` numeric(18,4), `quantity_unit`, `catalog_snapshot`, `kind: 'service'`, `configuration` jsonb. Dokładamy custom field `deal_id` na `E.sales.sales_quote`, żeby wersje dało się zebrać pod sprawą.

**Przedmiar — `renovation_takeoff`, moduł app-owned.** Trzy encje wiszące na `dealId` jako gołe uuid: `TakeoffRoom`, `TakeoffOpening`, `TakeoffScopeItem`. Plus komendy, generator wyceny, strony admina, akcja inbox i — w ostatniej fazie — efektor propozycji agenta.

Moduł nie ma encji nagłówkowej. Zdarzenie, na którym startuje proces agentowy, emituje **komenda**, nie encja: `renovation_takeoff.takeoff.start` tworzy deala przez `customers.deals.create` i emituje `renovation_takeoff.started`. Dzięki temu mamy własny trigger bez własnej tabeli i bez nasłuchiwania na `customers.deal.created`, które łapałoby każdego deala w systemie.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Sprawa jako `CustomerDeal` + custom fields | Lejek, timeline, aktywności, forecast i UI za darmo; jedna tabela mniej | Własny `RenovationCase` z `dealId` | Wariant pełny; tutaj nadmiarowy — sprawa bez deala i tak nie występuje w tym scenariuszu |
| Wycena jako `SalesQuote`, bez `EstimateVersion` | Numeracja, statusy, VAT, sumy, wysyłka, akceptacja, konwersja gotowe; wersjonowanie to kolejne dokumenty | Własna encja wersji kosztorysu | Wariant pełny; tutaj kosztowałaby dwie tabele i warstwę agregacji przy generowaniu oferty |
| Brak receptur — zakres wskazuje pozycję katalogową wprost | Zdejmuje moduł, dwie tabele i cały algorytm rozwijania; katalog i tak trzyma ceny i jednostki | Moduł `service_recipes` z nakładami na jednostkę | Odłożone świadomie; dodanie później nie wymaga migracji danych, tylko nowej opcjonalnej kolumny na `TakeoffScopeItem` |
| Własne zdarzenie emitowane przez komendę, nie przez encję | Daje trigger procesu bez tabeli nagłówkowej i bez łapania cudzych deali | Trigger na `customers.deal.created` z filtrem po `deal_kind` | `filterConditions` działają na ładunku zdarzenia, a `deal_kind` jest w EAV — nie ma go w ładunku `customers` |
| Powierzchnie liczy kod, agent zwraca wymiary | Błąd modelu w m² to zła oferta finansowa; arytmetyka nie jest zadaniem dla modelu | Agent zwraca gotowe powierzchnie | Decyzja przeniesiona z wariantu pełnego bez zmian |
| Zapis do `sales` i `customers` wyłącznie komendami | Sumy, VAT, undo, optimistic lock, audyt, historia | Bezpośredni zapis przez `em` | Utrata wszystkiego powyżej |

## Droga rozbudowy do wariantu pełnego

Ten wariant jest podzbiorem, nie ślepą uliczką. Kolejność dokładania, gdy okaże się potrzebne:

1. **Receptury** — nowy moduł `service_recipes`; `TakeoffScopeItem` dostaje opcjonalne `recipeId`; generator rozwija zakres po krokach, gdy pole jest wypełnione. Istniejące pozycje bez `recipeId` działają dalej.
2. **Kosztorys oddzielony od oferty** — `EstimateVersion` wchodzi między zakres a `SalesQuote`; generator przestaje pisać do `sales` wprost, a zaczyna z wersji zatwierdzonej.
3. **Własny nagłówek sprawy** — gdy potrzebna sprawa bez deala albo wielolokalizacyjna.

Krok 1 nie wymaga migracji danych. Krok 2 wymaga przeniesienia pozycji istniejących ofert do wersji, jeśli ma zostać zachowana historia.
