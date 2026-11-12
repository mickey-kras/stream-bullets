# Localization

## Scope and tone

Localize system UI only. Preserve brands, handles, and user content.
Use direct instructions: polite plural in Russian and Ukrainian, `du` in German, `vous` in French, familiar address in Spanish and Brazilian Portuguese.
Match idea-status gender where needed. Likes and dislikes are reactions. Poll choices are votes.

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

Chinese uses 投票 for polls and voting, 票 for counts.
Keep commonly used English product terms. Translate labels in context. Never replace user-content words.

## Roadmap statuses

`review`: awaiting decision. `planned`: accepted future work. `progress`: active work. `shipped`: available. `declined`: not planned.

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

Bug reports are public ideas. Optional metadata includes browser version and screen size only.
It excludes URLs, queries, fragments, screenshots, cookies, and account fields.
Users must review text before posting. The app does not redact it.

All locales have templates. The server rejects untouched templates in every locale.

API messages stay English. Non-English UI translates known codes, including handles, templates, images, dates, and security keys.
Unknown codes use translated HTTP-status guidance without internal validation details.
HTTP status and machine codes remain available. Schedule, community, and admin forms share the error formatter.

## Legal translation gaps

Terms and privacy remain English with a translated language notice.
No reviewed legal translations exist for de, es, fr, pl, pt-BR, ru, uk, hi, zh-CN, or ja.
UI notices and this glossary do not translate legal disclosures.

## Verification and native review

- Catalog checks: keys, placeholders, integer plural categories.
- Context tests: bug templates, error fallback, mixed-script drafts, counts.
- Browser checks: official labels, narrow layouts, locale changes with filters and fragments.

Locale selection adds no URL prefix and preserves canonical SEO behavior. `Intl` formats dates and counts.
Bundled fonts cover Latin and Cyrillic. CJK and Devanagari use system fallback.
One operating system cannot prove device-wide glyph coverage.
Before release, check Hindi shaping, Chinese and Japanese glyphs, and enlarged mixed-script names on Windows, macOS, Android, and iOS.

Native review remains needed for Hindi statuses, Japanese participation headlines, and Chinese poll terms.
Confirm Spanish, Brazilian Portuguese, and French tone and feminine idea-status labels.
Source corrections do not prove native-speaker certification.
