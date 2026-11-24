The search field is a search form with a **Search** button at the end.

The topic board and the streamer directory use it.

```jsx
<SearchField onSearch={(query) => setQuery(query)} />
<SearchField variant="streamers" />
```

| `variant` | Result |
| --- | --- |
| `topics` | The search of the topic board: `form.search`. Placeholder: "Search topics…". |
| `streamers` | The search of the streamer directory, in a `search` element. Placeholder: "Search by name or @handle…". |

- The field has a hidden label. `label` changes it.
- `onSearch` receives the query without the spaces at the start and at the end.
- On narrow screens, the button shows only the icon.
