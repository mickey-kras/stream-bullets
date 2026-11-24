Tabs are a toggle that sorts a list.

The topic board uses them for Top and New.
The active button is gold.

```jsx
<Tabs label="Topic sorting" items={[{ value: "top", label: "Top" }, { value: "newest", label: "New" }]} />
```

- The markup is a `fieldset.tabs` with a hidden legend and one button for each item.
- The active button has the `active` class and `aria-pressed="true"`.
- The default `className` is `sort-switch`. This class removes the frame of the fieldset.
- In the topic board, the tabs are in a `.list-toolbar`. If this toolbar has the **+** button, the tabs become narrow.
