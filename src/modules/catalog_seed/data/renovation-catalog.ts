/**
 * Katalog usług — dane w formacie zgodnym z modułem `catalog` Open Mercato.
 *
 * Human-readable wersja tego samego katalogu: prostokat-katalog-uslug.md
 *
 * Format wzięty z dwóch realnych źródeł w repo (nie zgadywany):
 * - `packages/core/src/modules/catalog/data/validators.ts` → `productBaseSchema` —
 *   to jest prawdziwy kształt payloadu tworzenia produktu (title, sku, handle,
 *   description, productType, defaultUnit, requiresShipping, isQuoteOnly, tags...).
 * - `packages/core/src/modules/catalog/seed/examples.ts` → `ProductSeed`/`VariantSeed` —
 *   wzorzec seeda z wariantami (`SERV-HAIR-60` itp.) pokazujący, jak seedować
 *   usługi (nie tylko towary fizyczne) z kilkoma wariantami i cenami per wariant.
 *
 * Świadome uproszczenia względem tamtych dwóch źródeł:
 * - Brak typu "service" w `CATALOG_PRODUCT_TYPES` (jest tylko simple/configurable/
 *   virtual/downloadable/bundle/grouped) — usługi mapujemy na `productType: 'virtual'`
 *   (niefizyczne, `requiresShipping: false`), zgodnie z tym, do czego ten typ
 *   faktycznie służy w module.
 * - `isQuoteOnly: true` — to są pozycje do wyceny indywidualnej (draft `SalesQuote`),
 *   nie towary ze sklepu z gotową ceną do kliknięcia "kup teraz".
 * - Pominięto `customFieldsetCode`/`variantFieldsetCode` z wewnętrznego `ProductSeed`
 *   modułu `catalog` (są tam wymagane, ale są sprzężone z demo custom fieldami tamtego
 *   seeda — fashion/hairdresser itp.). Jeśli `renovation_estimates` będzie potrzebować
 *   własnych custom fieldów, zadeklaruj dla nich osobny, lekki fieldset przez
 *   `defineFields`/`cf.*` — nie kopiuj fieldsetów z modułu `catalog`.
 * - Kategorie zamiast tagów — moduł `catalog` ma prawdziwe, hierarchiczne kategorie
 *   (`CatalogProductCategory`, tabela `catalog_product_categories`, join przez
 *   `CatalogProductCategoryAssignment`), więc branżę modelujemy tak samo jak
 *   `seed/examples.ts`: `RENOVATION_CATEGORY_TREE` (kształt `CategorySeed`: slug/name/
 *   description/children) + `categorySlug` na każdej usłudze wskazujący liść drzewa.
 *   "elewacja" jest podkategorią "wykonczenia" (tak jak w `poc-spec-wycena-remontow-ai-agentowa.md`),
 *   więc usługa z `categorySlug: 'elewacja'` pojawi się też pod kategorią nadrzędną
 *   dzięki `ancestorIds`/`descendantIds` liczonym przez `rebuildCategoryHierarchyForOrganization()`
 *   — nie trzeba przypinać produktu do obu poziomów naraz.
 *   Kategorie NIE mają tu z góry przypisanych UUID-ów (moduł generuje je przy insertcie
 *   `randomUUID()`-em) — seed usług musi najpierw upsertować `RENOVATION_CATEGORY_TREE`
 *   po `slug` (tak jak `ensureCategories()` w `seed/examples.ts`: znajdź po
 *   `(tenantId, organizationId, slug)`, w razie braku utwórz), zbudować mapę
 *   `slug → categoryId`, i dopiero wtedy wywołać `catalog.products.create`/`update`
 *   z `categoryIds: [categoryId]` (`productBaseSchema.categoryIds` wymaga realnych UUID).
 * - Cena to osobny obiekt (`{ regular }`), bo w OM cena NIE jest polem produktu —
 *   to osobny rekord (`CatalogProductVariantPrice`) przypięty do price kind "Regular" (PLN).
 *   Ten plik to dane wejściowe do seeda, nie gotowe wywołanie API/komend modułu catalog.
 * - Każda usługa ma co najmniej jeden wariant (`variants`, min. 1 element) — nawet gdy jest
 *   tylko jedna cena, dostaje wariant "Standard" z `isDefault: true`. To spójne z wzorcem
 *   `seed/examples.ts` (`VariantSeed` tam też zawsze ma co najmniej jeden wpis) i celowo
 *   ujednolica model dla wszystkich 45 usług — bez rozróżniania "cena na produkcie" vs
 *   "cena na wariancie" jako dwóch różnych kształtów danych.
 */

export type RenovationServiceUnit = 'm2' | 'szt' | 'mb' | 'kpl'

export type RenovationCategorySeed = {
  /** Slug kategorii — klucz do idempotentnego upsertu (tak jak `CategorySeed` w `seed/examples.ts`). */
  slug: string
  name: string
  description?: string
  children?: RenovationCategorySeed[]
}

export const RENOVATION_CATEGORY_TREE: RenovationCategorySeed[] = [
  {
    slug: 'wykonczenia',
    name: 'Wykończenia',
    description: 'Prace wykończeniowe wnętrz: malowanie, gładzie, tynki, podłogi, płytki.',
    children: [
      {
        slug: 'elewacja',
        name: 'Elewacja i docieplenie',
        description: 'Docieplenie, tynkowanie/malowanie elewacji, obróbki blacharskie, rynny.',
      },
    ],
  },
  {
    slug: 'stolarka',
    name: 'Stolarka',
    description: 'Drzwi, okna, parapety, zabudowy meblowe.',
  },
  {
    slug: 'elektryka',
    name: 'Elektryka',
    description: 'Punkty oświetleniowe, gniazda, łączniki, rozdzielnie, instalacje niskoprądowe.',
  },
  {
    slug: 'hydraulika',
    name: 'Hydraulika',
    description: 'Instalacje wod-kan, biały montaż, ogrzewanie (w tym podłogowe).',
  },
]

/** Liście `RENOVATION_CATEGORY_TREE`, na które mogą wskazywać usługi. */
export type RenovationCategorySlug =
  | 'wykonczenia'
  | 'elewacja'
  | 'stolarka'
  | 'elektryka'
  | 'hydraulika'

export type RenovationServiceVariant = {
  /** Nazwa wariantu pokazywana operatorowi, np. "Farba lateksowa premium". */
  name: string
  /** SKU wariantu: SKU produktu + sufiks. */
  sku: string
  /** Wariant domyślny — ta sama cena, co w wersji bez wariantów. */
  isDefault?: boolean
  /** Cecha materiałowa różnicująca wariant (klucz dowolny, tu zawsze "material"). */
  optionValues?: Record<string, string>
  /** Cena w price kind "Regular", PLN. */
  prices: { regular: number }
}

export type RenovationServiceSeed = {
  title: string
  handle: string
  sku: string
  description: string
  productType: 'virtual'
  requiresShipping: false
  isQuoteOnly: true
  defaultUnit: RenovationServiceUnit
  categorySlug: RenovationCategorySlug
  variants: RenovationServiceVariant[]
}

export const RENOVATION_SERVICE_CATALOG: RenovationServiceSeed[] = [
  // ---------------------------------------------------------------------------
  // WYKOŃCZENIA
  // ---------------------------------------------------------------------------
  {
    title: 'Malowanie ścian i sufitów',
    handle: 'malowanie-scian-i-sufitow',
    sku: 'REN-FIN-01',
    description: 'Dwukrotne malowanie po przygotowaniu podłoża.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [
      { name: 'Farba lateksowa standard', sku: 'REN-FIN-01-STD', isDefault: true, optionValues: { material: 'Farba lateksowa standard' }, prices: { regular: 40 } },
      { name: 'Farba lateksowa premium', sku: 'REN-FIN-01-PREM', optionValues: { material: 'Farba lateksowa premium (zmywalna, wyższe krycie)' }, prices: { regular: 55 } },
      { name: 'Farba silikatowa / ekologiczna', sku: 'REN-FIN-01-ECO', optionValues: { material: 'Farba silikatowa / ekologiczna' }, prices: { regular: 65 } },
    ],
  },
  {
    title: 'Gładź gipsowa jednowarstwowa',
    handle: 'gladz-gipsowa-jednowarstwowa',
    sku: 'REN-FIN-02',
    description: 'Wygładzenie powierzchni ścian/sufitów pod malowanie.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [{ name: 'Standard', sku: 'REN-FIN-02-STD', isDefault: true, prices: { regular: 35 } }],
  },
  {
    title: 'Tynkowanie maszynowe ścian',
    handle: 'tynkowanie-maszynowe-scian',
    sku: 'REN-FIN-03',
    description: 'Tynk maszynowy wewnętrzny wraz z zatarciem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [
      { name: 'Tynk cementowo-wapienny', sku: 'REN-FIN-03-CW', isDefault: true, optionValues: { material: 'Tynk cementowo-wapienny' }, prices: { regular: 50 } },
      { name: 'Tynk gipsowy maszynowy', sku: 'REN-FIN-03-GIPS', optionValues: { material: 'Tynk gipsowy maszynowy (gładszy, bez dodatkowej gładzi)' }, prices: { regular: 65 } },
    ],
  },
  {
    title: 'Skucie starych płytek / tynku',
    handle: 'skucie-starych-plytek-tynku',
    sku: 'REN-FIN-04',
    description: 'Demontaż istniejącego okładziny/tynku wraz z wywozem gruzu.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [{ name: 'Standard', sku: 'REN-FIN-04-STD', isDefault: true, prices: { regular: 30 } }],
  },
  {
    title: 'Układanie płytek podłogowych/ściennych',
    handle: 'ukladanie-plytek-podlogowych-sciennych',
    sku: 'REN-FIN-05',
    description: 'Ułożenie płytek na przygotowanym podłożu wraz z fugowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [
      { name: 'Płytki ceramiczne standard', sku: 'REN-FIN-05-CER', isDefault: true, optionValues: { material: 'Płytki ceramiczne standard' }, prices: { regular: 110 } },
      { name: 'Gres', sku: 'REN-FIN-05-GRES', optionValues: { material: 'Gres' }, prices: { regular: 140 } },
      { name: 'Gres wielkoformatowy / szkliwiony premium', sku: 'REN-FIN-05-PREM', optionValues: { material: 'Gres wielkoformatowy / szkliwiony premium' }, prices: { regular: 190 } },
    ],
  },
  {
    title: 'Wylewka samopoziomująca',
    handle: 'wylewka-samopoziomujaca',
    sku: 'REN-FIN-06',
    description: 'Wyrównanie podłogi masą samopoziomującą pod okładzinę.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [{ name: 'Standard', sku: 'REN-FIN-06-STD', isDefault: true, prices: { regular: 50 } }],
  },
  {
    title: 'Panele podłogowe z montażem',
    handle: 'panele-podlogowe-z-montazem',
    sku: 'REN-FIN-07',
    description: 'Ułożenie paneli podłogowych wraz z podkładem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [
      { name: 'Panele laminowane AC3 standard', sku: 'REN-FIN-07-AC3', isDefault: true, optionValues: { material: 'Panele laminowane AC3 standard' }, prices: { regular: 70 } },
      { name: 'Panele laminowane AC4', sku: 'REN-FIN-07-AC4', optionValues: { material: 'Panele laminowane AC4 (podwyższona odporność)' }, prices: { regular: 90 } },
      { name: 'Panele winylowe / SPC', sku: 'REN-FIN-07-SPC', optionValues: { material: 'Panele winylowe / SPC (wodoodporne, premium)' }, prices: { regular: 130 } },
    ],
  },
  {
    title: 'Demontaż i wywóz starej podłogi',
    handle: 'demontaz-i-wywoz-starej-podlogi',
    sku: 'REN-FIN-08',
    description: 'Zerwanie i wywóz istniejącej nawierzchni podłogowej.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'wykonczenia',
    variants: [{ name: 'Standard', sku: 'REN-FIN-08-STD', isDefault: true, prices: { regular: 18 } }],
  },

  // ---------------------------------------------------------------------------
  // ELEWACJA I DOCIEPLENIE (podkategoria Wykończeń)
  // ---------------------------------------------------------------------------
  {
    title: 'Docieplenie ścian zewnętrznych metodą lekką-mokrą',
    handle: 'docieplenie-scian-zewnetrznych',
    sku: 'REN-FIN-09',
    description: 'Ocieplenie ściany zewnętrznej styropianem z warstwą zbrojącą.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'elewacja',
    variants: [
      { name: 'Styropian 10 cm', sku: 'REN-FIN-09-10CM', optionValues: { material: 'Styropian 10 cm' }, prices: { regular: 190 } },
      { name: 'Styropian 12 cm', sku: 'REN-FIN-09-12CM', isDefault: true, optionValues: { material: 'Styropian 12 cm (jak w projekcie referencyjnym)' }, prices: { regular: 220 } },
      { name: 'Styropian 15 cm', sku: 'REN-FIN-09-15CM', optionValues: { material: 'Styropian 15 cm (podwyższona izolacyjność)' }, prices: { regular: 250 } },
    ],
  },
  {
    title: 'Tynkowanie/malowanie elewacji',
    handle: 'tynkowanie-malowanie-elewacji',
    sku: 'REN-FIN-10',
    description: 'Tynk cienkowarstwowy na elewacji wraz z gruntowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'elewacja',
    variants: [
      { name: 'Tynk akrylowy standard', sku: 'REN-FIN-10-AKR', isDefault: true, optionValues: { material: 'Tynk akrylowy standard' }, prices: { regular: 90 } },
      { name: 'Tynk silikonowo-silikatowy', sku: 'REN-FIN-10-SIL', optionValues: { material: 'Tynk silikonowo-silikatowy (samoczyszczący, trwalszy)' }, prices: { regular: 115 } },
    ],
  },
  {
    title: 'Obróbki blacharskie',
    handle: 'obrobki-blacharskie',
    sku: 'REN-FIN-11',
    description: 'Parapety zewnętrzne, gzymsy, opierzenia z blachy powlekanej.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'mb',
    categorySlug: 'elewacja',
    variants: [{ name: 'Standard', sku: 'REN-FIN-11-STD', isDefault: true, prices: { regular: 90 } }],
  },
  {
    title: 'Montaż/wymiana rynien i rur spustowych',
    handle: 'montaz-wymiana-rynien-i-rur-spustowych',
    sku: 'REN-FIN-12',
    description: 'Demontaż starych i montaż nowych rynien/rur spustowych.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'mb',
    categorySlug: 'elewacja',
    variants: [{ name: 'Standard', sku: 'REN-FIN-12-STD', isDefault: true, prices: { regular: 70 } }],
  },
  {
    title: 'Montaż kątowników ochronnych na oknach/drzwiach',
    handle: 'montaz-katownikow-ochronnych',
    sku: 'REN-FIN-13',
    description: 'Kątowniki ochronne na krawędziach ościeży okiennych i drzwiowych.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'mb',
    categorySlug: 'elewacja',
    variants: [{ name: 'Standard', sku: 'REN-FIN-13-STD', isDefault: true, prices: { regular: 25 } }],
  },

  // ---------------------------------------------------------------------------
  // STOLARKA
  // ---------------------------------------------------------------------------
  {
    title: 'Montaż drzwi wewnętrznych',
    handle: 'montaz-drzwi-wewnetrznych',
    sku: 'REN-CAR-01',
    description: 'Montaż skrzydła i ościeżnicy wraz z regulacją.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'stolarka',
    variants: [
      { name: 'Drzwi płytowe standard', sku: 'REN-CAR-01-STD', isDefault: true, optionValues: { material: 'Drzwi płytowe standard' }, prices: { regular: 400 } },
      { name: 'Drzwi fornirowane', sku: 'REN-CAR-01-FORN', optionValues: { material: 'Drzwi fornirowane' }, prices: { regular: 600 } },
      { name: 'Drzwi przeszklone / z naświetlem', sku: 'REN-CAR-01-SZKL', optionValues: { material: 'Drzwi przeszklone / z naświetlem' }, prices: { regular: 750 } },
    ],
  },
  {
    title: 'Montaż drzwi wejściowych / antywłamaniowych',
    handle: 'montaz-drzwi-wejsciowych-antywlamaniowych',
    sku: 'REN-CAR-02',
    description: 'Montaż drzwi zewnętrznych wraz z regulacją i uszczelnieniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'stolarka',
    variants: [
      { name: 'Klasa RC2 standard', sku: 'REN-CAR-02-RC2', isDefault: true, optionValues: { material: 'Klasa antywłamaniowa RC2 standard' }, prices: { regular: 1000 } },
      { name: 'Klasa RC3', sku: 'REN-CAR-02-RC3', optionValues: { material: 'Klasa antywłamaniowa RC3 (podwyższone bezpieczeństwo)' }, prices: { regular: 1400 } },
    ],
  },
  {
    title: 'Wymiana okna PVC',
    handle: 'wymiana-okna-pvc',
    sku: 'REN-CAR-03',
    description: 'Demontaż starego i montaż nowego okna wraz z uszczelnieniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'stolarka',
    variants: [
      { name: 'Profil PVC 3-komorowy standard', sku: 'REN-CAR-03-3K', isDefault: true, optionValues: { material: 'Profil PVC 3-komorowy standard' }, prices: { regular: 750 } },
      { name: 'Profil PVC 5-komorowy', sku: 'REN-CAR-03-5K', optionValues: { material: 'Profil PVC 5-komorowy (energooszczędny)' }, prices: { regular: 900 } },
      { name: 'Profil drewniany / aluminiowy', sku: 'REN-CAR-03-PREM', optionValues: { material: 'Profil drewniany / aluminiowy premium' }, prices: { regular: 1400 } },
    ],
  },
  {
    title: 'Montaż parapetu wewnętrznego',
    handle: 'montaz-parapetu-wewnetrznego',
    sku: 'REN-CAR-04',
    description: 'Montaż parapetu wewnętrznego wraz z uszczelnieniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'stolarka',
    variants: [
      { name: 'Parapet PCV standard', sku: 'REN-CAR-04-PCV', isDefault: true, optionValues: { material: 'Parapet PCV standard' }, prices: { regular: 120 } },
      { name: 'Parapet konglomeratowy / marmurowy', sku: 'REN-CAR-04-PREM', optionValues: { material: 'Parapet konglomeratowy / marmurowy premium' }, prices: { regular: 220 } },
    ],
  },
  {
    title: 'Zabudowa meblowa / szafa wnękowa',
    handle: 'zabudowa-meblowa-szafa-wnekowa',
    sku: 'REN-CAR-05',
    description: 'Zabudowa meblowa na wymiar (podstawowa konfiguracja).',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'mb',
    categorySlug: 'stolarka',
    variants: [{ name: 'Standard', sku: 'REN-CAR-05-STD', isDefault: true, prices: { regular: 850 } }],
  },

  // ---------------------------------------------------------------------------
  // ELEKTRYKA
  // ---------------------------------------------------------------------------
  {
    title: 'Punkt oświetleniowy sufitowy (plafon)',
    handle: 'punkt-oswietleniowy-sufitowy-plafon',
    sku: 'REN-ELE-01',
    description: 'Wykonanie punktu pod oprawę sufitową wraz z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-01-STD', isDefault: true, prices: { regular: 140 } }],
  },
  {
    title: 'Punkt oświetleniowy z reflektorkami / oczkami LED',
    handle: 'punkt-oswietleniowy-reflektorki-led',
    sku: 'REN-ELE-02',
    description: 'Punkt pod oświetlenie punktowe wpuszczane w suficie podwieszanym.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-02-STD', isDefault: true, prices: { regular: 120 } }],
  },
  {
    title: 'Kinkiet (wypust ścienny oświetleniowy)',
    handle: 'kinkiet-wypust-scienny',
    sku: 'REN-ELE-03',
    description: 'Wykonanie punktu pod oprawę ścienną.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-03-STD', isDefault: true, prices: { regular: 130 } }],
  },
  {
    title: 'Gniazdo elektryczne pojedyncze',
    handle: 'gniazdo-elektryczne-pojedyncze',
    sku: 'REN-ELE-04',
    description: 'Podtynkowy punkt gniazda 230V z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-04-STD', isDefault: true, prices: { regular: 90 } }],
  },
  {
    title: 'Gniazdo elektryczne podwójne',
    handle: 'gniazdo-elektryczne-podwojne',
    sku: 'REN-ELE-05',
    description: 'Podtynkowy punkt gniazda podwójnego z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-05-STD', isDefault: true, prices: { regular: 110 } }],
  },
  {
    title: 'Gniazdo elektryczne potrójne w ramce',
    handle: 'gniazdo-elektryczne-potrojne-w-ramce',
    sku: 'REN-ELE-06',
    description: 'Podtynkowy punkt trzech gniazd w jednej ramce.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-06-STD', isDefault: true, prices: { regular: 150 } }],
  },
  {
    title: 'Gniazdo hermetyczne IP44',
    handle: 'gniazdo-hermetyczne-ip44',
    sku: 'REN-ELE-07',
    description: 'Gniazdo natynkowe/podtynkowe IP44 do łazienki, kuchni lub na zewnątrz.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-07-STD', isDefault: true, prices: { regular: 140 } }],
  },
  {
    title: 'Gniazdo dedykowane pod AGD',
    handle: 'gniazdo-dedykowane-agd',
    sku: 'REN-ELE-08',
    description: 'Osobny obwód i gniazdo pod piekarnik / zmywarkę / lodówkę.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-08-STD', isDefault: true, prices: { regular: 220 } }],
  },
  {
    title: 'Gniazdo RTV/SAT',
    handle: 'gniazdo-rtv-sat',
    sku: 'REN-ELE-09',
    description: 'Punkt anteny RTV/SAT z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-09-STD', isDefault: true, prices: { regular: 100 } }],
  },
  {
    title: 'Gniazdo internetowe RJ45',
    handle: 'gniazdo-internetowe-rj45',
    sku: 'REN-ELE-10',
    description: 'Punkt sieciowy RJ45 z okablowaniem strukturalnym.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-10-STD', isDefault: true, prices: { regular: 110 } }],
  },
  {
    title: 'Łącznik światła pojedynczy',
    handle: 'lacznik-swiatla-pojedynczy',
    sku: 'REN-ELE-11',
    description: 'Podtynkowy włącznik pojedynczy z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-11-STD', isDefault: true, prices: { regular: 90 } }],
  },
  {
    title: 'Łącznik światła schodowy',
    handle: 'lacznik-swiatla-schodowy',
    sku: 'REN-ELE-12',
    description: 'Włącznik dwuobwodowy (schodowy) z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-12-STD', isDefault: true, prices: { regular: 110 } }],
  },
  {
    title: 'Łącznik światła krzyżowy',
    handle: 'lacznik-swiatla-krzyzowy',
    sku: 'REN-ELE-13',
    description: 'Włącznik krzyżowy (sterowanie z 3+ miejsc) z okablowaniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-13-STD', isDefault: true, prices: { regular: 130 } }],
  },
  {
    title: 'Montaż/wymiana rozdzielni elektrycznej mieszkaniowej',
    handle: 'montaz-wymiana-rozdzielni-elektrycznej',
    sku: 'REN-ELE-14',
    description: 'Wymiana lub rozbudowa rozdzielni wraz z zabezpieczeniami.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'kpl',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-14-STD', isDefault: true, prices: { regular: 1600 } }],
  },
  {
    title: 'Punkt pod domofon/wideodomofon',
    handle: 'punkt-domofon-wideodomofon',
    sku: 'REN-ELE-15',
    description: 'Okablowanie i punkt pod instalację domofonową/wideodomofonową.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'elektryka',
    variants: [{ name: 'Standard', sku: 'REN-ELE-15-STD', isDefault: true, prices: { regular: 180 } }],
  },

  // ---------------------------------------------------------------------------
  // HYDRAULIKA (w tym ogrzewanie)
  // ---------------------------------------------------------------------------
  {
    title: 'Przyłącze wod-kan do urządzenia',
    handle: 'przylacze-wod-kan-do-urzadzenia',
    sku: 'REN-PLU-01',
    description: 'Doprowadzenie zimnej i ciepłej wody do umywalki/zlewu.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-01-STD', isDefault: true, prices: { regular: 320 } }],
  },
  {
    title: 'Przyłącze wody do WC',
    handle: 'przylacze-wody-do-wc',
    sku: 'REN-PLU-02',
    description: 'Doprowadzenie wody do miski ustępowej.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-02-STD', isDefault: true, prices: { regular: 220 } }],
  },
  {
    title: 'Podłączenie pralki / zmywarki',
    handle: 'podlaczenie-pralki-zmywarki',
    sku: 'REN-PLU-03',
    description: 'Podłączenie wody i odpływu do pralki lub zmywarki.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-03-STD', isDefault: true, prices: { regular: 280 } }],
  },
  {
    title: 'Odpływ liniowy (prysznic bezbrodzikowy)',
    handle: 'odplyw-liniowy-prysznic-bezbrodzikowy',
    sku: 'REN-PLU-04',
    description: 'Montaż odpływu liniowego pod prysznic bezbrodzikowy.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-04-STD', isDefault: true, prices: { regular: 450 } }],
  },
  {
    title: 'Montaż baterii',
    handle: 'montaz-baterii',
    sku: 'REN-PLU-05',
    description: 'Montaż baterii umywalkowej / zlewozmywakowej / prysznicowej.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-05-STD', isDefault: true, prices: { regular: 180 } }],
  },
  {
    title: 'Biały montaż (WC, umywalka, bateria)',
    handle: 'bialy-montaz-wc-umywalka-bateria',
    sku: 'REN-PLU-06',
    description: 'Montaż kompletu sanitarnego bez kosztu ceramiki.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'kpl',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-06-STD', isDefault: true, prices: { regular: 750 } }],
  },
  {
    title: 'Montaż brodzika / kabiny prysznicowej',
    handle: 'montaz-brodzika-kabiny-prysznicowej',
    sku: 'REN-PLU-07',
    description: 'Montaż brodzika i kabiny prysznicowej wraz z uszczelnieniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-07-STD', isDefault: true, prices: { regular: 650 } }],
  },
  {
    title: 'Wymiana odcinka instalacji wod-kan',
    handle: 'wymiana-odcinka-instalacji-wod-kan',
    sku: 'REN-PLU-08',
    description: 'Wymiana odcinka rur wodociągowo-kanalizacyjnych.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'mb',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-08-STD', isDefault: true, prices: { regular: 200 } }],
  },
  {
    title: 'Montaż/wymiana grzejnika',
    handle: 'montaz-wymiana-grzejnika',
    sku: 'REN-PLU-09',
    description: 'Demontaż starego i montaż nowego grzejnika wraz z podłączeniem.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [
      { name: 'Grzejnik płytowy standard', sku: 'REN-PLU-09-STD', isDefault: true, optionValues: { material: 'Grzejnik płytowy standard' }, prices: { regular: 350 } },
      { name: 'Grzejnik dekoracyjny / łazienkowy', sku: 'REN-PLU-09-DEKO', optionValues: { material: 'Grzejnik dekoracyjny / łazienkowy (drabinkowy)' }, prices: { regular: 550 } },
    ],
  },
  {
    title: 'Montaż zaworu termostatycznego',
    handle: 'montaz-zaworu-termostatycznego',
    sku: 'REN-PLU-10',
    description: 'Montaż zaworu termostatycznego na grzejniku.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-10-STD', isDefault: true, prices: { regular: 90 } }],
  },
  {
    title: 'Wykonanie ogrzewania podłogowego',
    handle: 'wykonanie-ogrzewania-podlogowego',
    sku: 'REN-PLU-11',
    description: 'Ułożenie instalacji ogrzewania podłogowego wodnego.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'm2',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-11-STD', isDefault: true, prices: { regular: 180 } }],
  },
  {
    title: 'Montaż/podłączenie termostatu pokojowego',
    handle: 'montaz-podlaczenie-termostatu-pokojowego',
    sku: 'REN-PLU-12',
    description: 'Montaż i podłączenie termostatu pokojowego do instalacji grzewczej.',
    productType: 'virtual',
    requiresShipping: false,
    isQuoteOnly: true,
    defaultUnit: 'szt',
    categorySlug: 'hydraulika',
    variants: [{ name: 'Standard', sku: 'REN-PLU-12-STD', isDefault: true, prices: { regular: 150 } }],
  },
]
