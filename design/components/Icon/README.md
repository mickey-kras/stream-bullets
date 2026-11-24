An icon is an outline glyph on a 24px grid with a 1.8 stroke.

It takes the text color.
The part imports the custom glyphs of the app from `app/components/ui/icon-paths.tsx`.
It imports the general icons from the `lucide-react` package.
Thus, the icons are the same as in the app, and they need no network.

```jsx
<Icon name="topics" size={20} />
<Icon name="thumbs-up-filled" size={24} />
<Icon name="streamers" />
```

- Sizes: 16px for metadata, 18px for buttons and menus, 20px for navigation and close, 24px for votes and categories, and 40px for empty states. The default is 18px.
- The `svg` has the classes `icon`, `icon-<size>`, and `icon-<name>`. The CSS of the app uses these classes.
- If a custom glyph and a Lucide icon have the same name, the custom glyph shows.
- `ICON_NAMES` lists all the names.
- An icon is decorative. Give the label to the control that holds the icon.
