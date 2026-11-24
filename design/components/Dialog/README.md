A dialog is a modal panel of 560px in the center of the page.

It is a native `dialog` element. `showModal()` keeps the focus in it.
The backdrop behind it is `#000b` with a blur.

Put Cancel first and the primary action last.
The Escape key and the close button close the dialog. A click on the backdrop closes it in browsers that support the `closedby` attribute.
`inline` shows the dialog in the page flow, for previews.

```jsx
<Dialog open={open} onOpenChange={setOpen} title="Suggest a topic" description="What would make a great conversation?"
  actions={<Button variant="gold" font="display">Submit topic</Button>}>
  <TextField label="Title" required />
</Dialog>
```
