A choice is a radio button or a checkbox in a row with a border.

The row becomes gold when you select it.
The display settings and the moderation sheet use it.

```jsx
<Choice name="cvd" label="Default colors" defaultChecked />
<Choice name="cvd" label="Red-green safe" help="Protanopia and deuteranopia" />
<Choice type="checkbox" label="Readable font" help="Body font for headings, no all-caps, more spacing" />
```

- The markup is a `label.choice` with the input and a text `span`. The `help` text is a `small` element.
- The app styles the row in a dialog (`.modal-content`) or in a settings group (`.pref-group`). Put the choice in one of these containers.
