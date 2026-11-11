# Localization

## Scope and tone

System UI uses the active locale. Brand names, handles, and user content stay unchanged.
Use direct instructions. Russian and Ukrainian use polite plural address throughout.
German uses `du`; French uses `vous`. Spanish and Brazilian Portuguese use familiar, direct instructions.
Idea status labels agree with the word for idea where the language requires gender agreement.
A like or dislike is a reaction. A vote selects one poll option. These actions are distinct.

## Glossary

| Locale | Topic | Idea | Poll | Vote | Like | Dislike | Comment | Streamer | Community |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| en | topic | idea | poll | vote | like | dislike | comment | streamer | community |
| de | Thema | Idee | Umfrage | Stimme | Gefällt mir | Gefällt mir nicht | Kommentar | Streamer | Community |
| es | tema | idea | encuesta | voto | me gusta | no me gusta | comentario | streamer | comunidad |
| fr | sujet | idée | sondage | vote | j’aime | je n’aime pas | commentaire | streamer | communauté |
| pl | temat | pomysł | ankieta | głos | lubię | nie lubię | komentarz | streamer | społeczność |
| pt-BR | tema | ideia | enquete | voto | curtir | não curtir | comentário | streamer | comunidade |
| ru | тема | идея | опрос | голос | нравится | не нравится | комментарий | стример | сообщество |
| uk | тема | ідея | опитування | голос | подобається | не подобається | коментар | стример | спільнота |
| hi | विषय | सुझाव | पोल | वोट | पसंद | नापसंद | टिप्पणी | स्ट्रीमर | समुदाय |
| zh-CN | 话题 | 建议 | 投票 | 票 | 赞 | 踩 | 评论 | 主播 | 社区 |
| ja | 話題 | アイデア | アンケート | 票 | いいね | よくないね | コメント | 配信者 | コミュニティ |

Chinese uses 投票 for the poll and the act of voting. Counts use 票.
English product vocabulary is retained where it is established in the target locale.
Translate labels in context; do not replace words in user content.

## Roadmap statuses

`review` means awaiting a product decision. `planned` means accepted for future work.
`progress` means active work. `shipped` means available to users. `declined` means not planned.

| Locale | Review | Planned | In progress | Shipped | Not planned |
| --- | --- | --- | --- | --- | --- |
| en | Under review | Planned | In progress | Shipped | Not planned |
| de | Wird geprüft | Geplant | In Arbeit | Veröffentlicht | Nicht geplant |
| es | En revisión | Planificada | En curso | Publicada | No planificada |
| fr | À l’étude | Prévue | En cours | Livrée | Non prévue |
| pl | W ocenie | Zaplanowane | W toku | Wydane | Nieplanowane |
| pt-BR | Em análise | Planejada | Em andamento | Lançada | Não planejada |
| ru | На рассмотрении | Запланировано | В работе | Выпущено | Не планируется |
| uk | На розгляді | Заплановано | У роботі | Випущено | Не заплановано |
| hi | समीक्षा में | योजना में | प्रगति में | उपलब्ध | योजना में नहीं |
| zh-CN | 审核中 | 已计划 | 进行中 | 已上线 | 不计划 |
| ja | 検討中 | 予定 | 対応中 | リリース済み | 予定なし |

## Reports and errors

Bug reports are public ideas. The optional metadata adds browser version and screen size.
It does not add the page URL, query string, fragment, screenshot, cookies, or account fields.
The typed report text is not automatically redacted. Users must review it before posting.
Bug templates exist for every locale. The server rejects an untouched template from any locale.

API response messages remain English for compatibility. Non-English UI uses translated status guidance.
Status and machine-readable error codes remain available to callers.
Detailed server validation reasons still need stable translation keys; status guidance is less specific.

## Legal translation gaps

Terms and privacy disclosures remain in English, with the existing translated language notice.
There are no reviewed legal translations for de, es, fr, pl, pt-BR, ru, uk, hi, zh-CN, or ja.
Do not treat translated UI notices or this glossary as translations of legal disclosures.

## Verification and native review

Catalog checks cover keys, placeholders, and integer plural categories.
Context tests cover bug templates, error fallback, mixed-script draft text, and counts.
Browser checks cover official labels, narrow layouts, and language changes with filters and fragments.
Canonical URLs retain the existing SEO behavior; locale selection does not add a URL prefix.
Dates and counts use the active locale through `Intl`.

The bundled fonts cover Latin and Cyrillic. CJK and Devanagari depend on system font fallback.
A browser test on one operating system cannot certify glyph coverage on all supported devices.
Review Hindi shaping and Chinese/Japanese glyphs on Windows, macOS, Android, and iOS before release.
Review long mixed-script user names at enlarged text settings on those platforms.

Native review is still needed for Hindi status wording, Japanese participation headlines, and Chinese poll terminology.
Also confirm regional tone in Spanish, Brazilian Portuguese, and French, including feminine idea status labels.
These changes are source-based corrections, not a claim of native-speaker certification.
