The text field has the label above the field and the help text below it.

The dialogs of the app use this pattern.

```jsx
<TextField label="Title" name="title" required maxLength={100} />
<TextField label="Details" name="body" required multiline rows={5} />
<TextField label="Options, one per line" multiline help="2 to 6 distinct options. Up to 80 characters each." />
```

- The markup is a `label` with a text `span`, the `input` or `textarea`, and a `small` help text.
- The app styles the field in a dialog (`.modal-content`) or on the settings page. Put the field in one of these containers.
- For a sheet, use `className="field"` and `labelClassName="field-label"`.
- `error` adds `aria-invalid` and a red border. If `error` is text, the text shows below the field.
