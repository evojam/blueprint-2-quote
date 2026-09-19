# Agent dopasowujący tekst do elementów katalogu

## Cel

Agent przyjmuje tekst jako argument, wyszukuje potencjalnie pasujące rekordy produktów w module `catalog` i zwraca uporządkowaną listę kandydatów. Agent działa wyłącznie w trybie odczytu i nie modyfikuje katalogu.

## Przykładowe wejście

```json
{
  "text": "Wykonanie projektu instalacji elektrycznej dla lokalu 120 m²",
  "limit": 5
}
```

## Rekomendowany przepływ

1. Sprawdzić, czy `text` jest niepustym tekstem o długości do 4000 znaków, a opcjonalny `limit` jest liczbą całkowitą od 1 do 10; domyślny limit wynosi 5.
2. Wywołać istniejące narzędzie `catalog.search_products`, przekazując tekst jako `q`.
3. Traktować każdy zwrócony rekord `catalog_product` jako dopuszczalnego kandydata, niezależnie od typu, kategorii, tagów i atrybutów.
4. Dla najlepszych kandydatów opcjonalnie wywołać `catalog.get_product_bundle`, aby pobrać szczegóły potrzebne do dokładniejszego porównania.
5. Porównać tekst wejściowy z tytułem, opisem, SKU, tagami, kategoriami i atrybutami kandydatów.
6. Zwrócić ranking zawierający wyłącznie identyfikatory otrzymane z narzędzi katalogowych.
7. Odrzucić kandydatów z wynikiem poniżej `0.60`; jeżeli żaden kandydat nie osiąga progu, zwrócić pustą tablicę.

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

Agent `property_documents.catalog_matcher` powinien korzystać tylko z narzędzi read-only:

- `catalog.search_products` — wyszukiwanie kandydatów; dla niepustego `q` korzysta z wyszukiwania hybrydowego i zwraca wyniki ograniczone do bieżącego tenant/organization scope,
- `catalog.get_product_bundle` — pobranie pełniejszego kontekstu wybranych kandydatów.

## Brak oznaczenia usług

Moduł `catalog` nie posiada osobnego typu produktu `service`, a rekordy przeznaczone do mapowania nie będą oznaczane kanoniczną kategorią, tagiem, custom fieldem ani atrybutem.

Agent nie filtruje więc kandydatów według oznaczenia usługi i nie klasyfikuje, czy rekord jest usługą. Każdy `catalog_product` zwrócony przez scoped wyszukiwanie może zostać dopasowany, jeśli jego treść dostarcza wystarczających dowodów.

## Inwarianty bezpieczeństwa i jakości

- `tenantId` i `organizationId` pochodzą z zaufanego kontekstu wykonania, nigdy z argumentu agenta.
- Agent nie odczytuje katalogu bezpośrednio z bazy, jeśli istnieją scoped narzędzia katalogowe.
- Model nie może wymyślać `catalogProductId`; każdy zwrócony identyfikator musi pochodzić z odpowiedzi narzędzia.
- Wynik jest sugestią i nie tworzy, nie aktualizuje ani nie przypisuje rekordów katalogowych.
- `score` powinien mieścić się w zakresie 0–1 i służyć do rankingu, nie jako bezwzględna gwarancja poprawności.
- `matchedEvidence` powinno wskazywać konkretne elementy, które uzasadniają dopasowanie.
- Brak wiarygodnego dopasowania powinien skutkować pustą tablicą, a nie wymyślonym kandydatem.

## Najmniejszy kompletny wariant

Dla pierwszej wersji nie jest potrzebny nowy indeks ani nowa warstwa dostępu do danych. Wystarczy natywny agent `property_documents.catalog_matcher` wykorzystujący `catalog.search_products`, opcjonalnie `catalog.get_product_bundle`, oraz ściśle typowany wynik z listą dopasowań.
