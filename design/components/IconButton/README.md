An icon button is a button with an icon and no visible text.

The button is 40px. On phones, it is 44px.

```jsx
<IconButton label="Refresh comments" icon="refresh" />
<IconButton label="Copy link" icon="copy" />
<IconButton label="Close" icon="close" className="modal-close" />
```

- Always give a `label`. The label is the accessible name. It is also the tooltip if you do not give a `title`.
- The icon is 20px. Use `iconSize` to change it.
- Increase `spin` to turn the icon one time, for example after a refresh. Focus stays on the button.
- The close button of a dialog adds the `modal-close` class.
