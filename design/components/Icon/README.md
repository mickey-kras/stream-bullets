An icon is an outline glyph on a 24px grid with a 1.8 stroke.

It takes the text color.
The custom glyphs come from the code. General icons come from Lucide.

```jsx
<Icon name="topics" size={20} />
<Icon name="thumbs-up-filled" size={24} />
<Icon name="streamers" size={18} />
```

- Sizes: 16px for metadata, 18px for buttons, 20px for navigation and close, 24px for votes and categories, and 40px for empty states.
- The custom glyphs show immediately. Lucide names load the Lucide UMD file from unpkg when the page needs them.
- An icon is decorative. Give the label to the control that holds the icon.
