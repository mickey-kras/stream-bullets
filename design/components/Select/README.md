The select is a combobox that only lets you select a value.

The part uses Radix Select, as the app does.
It has a trigger and a list. A gold check marks the selected option.

```jsx
<div className="field">
  <span className="field-label" id="cat-label">Category</span>
  <Select id="cat" labelledBy="cat-label" defaultValue="Tech & setups"
    options={[{ value: "Tech & setups", label: "Tech & setups", icon: "cat-tech" }]} />
</div>
<Select label="Sort comments" defaultValue="newest" options={[{ value: "newest", label: "Newest" }]} />
```

- Give `label` or `labelledBy`. The select uses it as the accessible name.
- `name` adds a hidden input to the form.
- The value of an option must not be empty.
- In a modal `dialog` element, the list opens in that dialog. The page outside the dialog does not accept input.
