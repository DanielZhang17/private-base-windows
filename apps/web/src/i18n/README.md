# Localization

English is the typed source of truth. `t("missing.key")` fails the TypeScript check.
Views import `t` and `useLocale` from this directory; `useLocale()` subscribes to changes,
and formatting helpers always read the resolved app language. English ships in the entry
bundle; each other locale is a Vite chunk loaded from the app bundle, with no translation service.
`main.tsx` awaits initialization before rendering. Locale load failure falls back to English.

The device preference is `private-base:locale` in localStorage (`system` or a supported code).
Missing, invalid or inaccessible storage means System. System walks navigator.languages in
order, including Chinese script/region and Portuguese region mapping. `languagechange` follows
the OS only in System mode. Explicit changes apply immediately and survive sign-out. The
preference never enters account data or an API request. Each locale declares its direction;
initialization and changes update html lang/dir. Add a future RTL locale's direction there.

Keep complete sentences in resources; interpolate names and values. Preserve Private Base,
user text, recovery keys, safety numbers, character/style names, file formats and the literal
DELETE confirmation token. Known service messages/codes are mapped in features/shared/errors.ts.
Unknown diagnostics retain the existing English behavior in English; other languages use
localized fallback copy. No translator is passed into crypto or services.

`locales.test.ts` checks identical key sets, each locale's Intl plural categories, nonempty
translations and interpolation variables. For each counted phrase, every resource includes the shared union of `_one`, `_few`,
`_many` and `_other`. Intl selects only the forms used by that language at runtime. The JSX guard covers the views,
components and UI gallery, including default accessible labels.

## Native branches: metadata to add

No native wrapper files were edited here. Both macOS and iOS Info.plist need
[CFBundleLocalizations](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundlelocalizations)
as an array containing:

```text
en, zh-Hans, zh-Hant, ja, ko, de, es, fr, pt-BR, pt-PT, it, ru
```

On Android, add `res/xml/locale_config.xml` and reference it on the application element as
`android:localeConfig="@xml/locale_config"`. Declare `<locale android:name="…"/>` for each of
those same 12 BCP 47 tags. The default native resources should use English. Declare the same
languages in the app module's Gradle `defaultConfig`:

```kotlin
resourceConfigurations += listOf(
    "en", "b+zh+Hans", "b+zh+Hant", "ja", "ko", "de", "es", "fr",
    "pt-rBR", "pt-rPT", "it", "ru"
)
```

See Android's [per-app language metadata](https://developer.android.com/guide/topics/resources/app-languages#use-localeconfig)
and [script/region resource qualifiers](https://developer.android.com/guide/topics/resources/providing-resources#AlternativeResources).
The bundled web locale files are separate from Android string resources; list them explicitly
when generating native locale metadata. Tauri uses navigator.languages, so OS detection needs
no native bridge. Windows uses the same bundled web resources and browser detection.

## Durable-data audit (localization fix round 1)

Outgoing queue `error` fields store English-source keys; rendering resolves them against the
current locale. Both the initial file-preparation record and every send/retry catch normalize
errors before persistence. Queue restoration converts legacy diagnostics to keys. An interrupted
file is recognized from its missing encrypted upload/envelope, so its old language bundle is not
needed to restore the reattachment instruction. Error translation never feeds queue persistence.

Other audited writes retain data rather than UI copy: IndexedDB messages contain user content,
file caches contain encrypted/download metadata, pending calls contain call identifiers and keys,
auth persistence contains account/device/session data, UI persistence contains theme/color values,
locale storage contains a code, recovery retry storage contains identifiers and device names, and
safety-number storage contains the public number. Server writes contain protocol fields or
user-chosen profile/chat/emoji content. The generated default device name is user content and is
intentionally localized. No other translated UI text reaches those stores or requests.

Context-specific keys distinguish navigation landmarks, call titles, message status, file type,
settings sections, gallery button styles and actions from labels. The JSX guard rejects mixed
translation/text runs, template-literal composition and string addition; messages interpolate
values as a complete unit instead. Chinese script checks and Portuguese vocabulary checks protect
regional copy. Both Chinese resources use consistent recovery/passkey/private-key terminology;
Japanese/Korean use polite explanatory copy with compact actions, German/French keep actions
short, Spanish uses usted, Italian uses tu, and Russian uses formal вы.
