# Agent dopasowujący tekst do usług katalogowych

## Cel

Agent przyjmuje tekst jako argument, wyszukuje potencjalnie pasujące usługi w module `catalog` i zwraca uporządkowaną listę kandydatów. Agent działa wyłącznie w trybie odczytu i nie modyfikuje katalogu.

## Przykładowe wejście

```json
{
  "text": "Wykonanie projektu instalacji elektrycznej dla lokalu 120 m²",
  "limit": 5
}
```

## Rekomendowany przepływ

1. Zweryfikować i ograniczyć długość pola `text` oraz opcjonalnego `limit`.
2. Wywołać istniejące narzędzie `catalog.search_products`, przekazując tekst jako `q`.
3. Ograniczyć kandydatów do rekordów oznaczonych jako usługi.
4. Dla najlepszych kandydatów opcjonalnie wywołać `catalog.get_product_bundle`, aby pobrać szczegóły potrzebne do dokładniejszego porównania.
5. Porównać tekst wejściowy z tytułem, opisem, SKU, tagami i atrybutami kandydatów.
6. Zwrócić ranking zawierający wyłącznie identyfikatory otrzymane z narzędzi katalogowych.
7. Jeżeli żaden kandydat nie przekracza ustalonego progu dopasowania, zwrócić pustą tablicę.

## Przykładowy wynik

```json
{
  "matches": [
    {
      "catalogProductId": "7f92...",
      "title": "Projekt instalacji elektrycznej",
      "score": 0.91,
      "matchedEvidence": [
        "projekt instalacji",
        "lokal usługowy",
        "rozliczenie za m²"
      ],
      "reason": "Zgodność rodzaju projektu i jednostki rozliczeniowej."
    }
  ],
  "unmatchedTerms": ["120 m²"]
}
```

## Narzędzia agenta

Rekomendowany agent, np. `property_documents.service_matcher`, powinien korzystać tylko z narzędzi read-only:

- `catalog.search_products` — wyszukiwanie kandydatów; dla niepustego `q` korzysta z wyszukiwania hybrydowego i zwraca wyniki ograniczone do bieżącego tenant/organization scope,
- `catalog.get_product_bundle` — pobranie pełniejszego kontekstu wybranych kandydatów.

## Oznaczanie usług w katalogu

Moduł `catalog` nie posiada osobnego typu produktu `service`. Dostępne typy obejmują m.in. `simple`, `configurable`, `virtual`, `downloadable`, `bundle` i `grouped`.

Usługi należy więc jednoznacznie oznaczać za pomocą jednego kanonicznego mechanizmu, np.:

- kategorii `Usługi`,
- tagu `service`,
- dedykowanego custom field lub atrybutu.

Agent powinien filtrować kandydatów według tego oznaczenia. Nie powinien samodzielnie zgadywać, czy rekord katalogowy jest usługą.

## Inwarianty bezpieczeństwa i jakości

- `tenantId` i `organizationId` pochodzą z zaufanego kontekstu wykonania, nigdy z argumentu agenta.
- Agent nie odczytuje katalogu bezpośrednio z bazy, jeśli istnieją scoped narzędzia katalogowe.
- Model nie może wymyślać `catalogProductId`; każdy zwrócony identyfikator musi pochodzić z odpowiedzi narzędzia.
- Wynik jest sugestią i nie tworzy, nie aktualizuje ani nie przypisuje rekordów katalogowych.
- `score` powinien mieścić się w zakresie 0–1 i służyć do rankingu, nie jako bezwzględna gwarancja poprawności.
- `matchedEvidence` powinno wskazywać konkretne elementy, które uzasadniają dopasowanie.
- Brak wiarygodnego dopasowania powinien skutkować pustą tablicą, a nie wymyślonym kandydatem.

## Najmniejszy kompletny wariant

Dla pierwszej wersji nie jest potrzebny nowy indeks ani nowa warstwa dostępu do danych. Wystarczy dedykowany agent wykorzystujący `catalog.search_products`, opcjonalnie `catalog.get_product_bundle`, oraz ściśle typowany wynik z listą dopasowań.
