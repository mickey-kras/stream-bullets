The category plate shows the category of a topic above the topic title.

It has a thin border, a category icon, and Oswald text in uppercase.
The topic detail uses it at the top of a topic.

Give the stored category name. The part then selects the icon, as the app does:

| Category | Icon |
| --- | --- |
| Tech & setups | `cat-tech` |
| Gaming | `cat-gaming` |
| Creative | `cat-creative` |
| Just chatting | `cat-chatting` |

An unknown category shows the `cat-tech` icon.
Use the `icon` prop to set a different icon.

```jsx
<Category category="Gaming" />
<Category icon="idea">Feature</Category>
```

The file also exports `categoryIcon(category)`, which gives the icon name of a category.
