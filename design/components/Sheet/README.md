A sheet is a dialog for long content.

It has a sticky head, a body that scrolls, and actions below the body.
On phones, it fills the screen. Set `short` to keep a card in the center on phones.
Settings, the account dialogs, and the page editor use it.

Give `onBack` to show the **Back** step in the head.
The `description` is for screen readers only. Show the same text in the body.
`name` sets the `data-sheet` attribute.

```jsx
<Sheet open={open} onOpenChange={setOpen} title="Edit your page" onBack={back}
  actions={<button type="submit" className="gold">Save</button>}>
  <label>Page name<input defaultValue="Sunny" /></label>
</Sheet>
```
