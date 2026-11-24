A dialog is a modal panel of 560px in the center of the page.

The backdrop behind it is `#000b` with a blur.
Put Cancel first and the primary action last.
The Escape key, the backdrop, and the close button close the dialog.

```jsx
<Dialog open={open} onOpenChange={setOpen} title="Suggest a topic" description="What would make a great conversation?"
  actions={<Button variant="gold" font="display">Submit topic</Button>}>
  <TextField label="Title" required />
</Dialog>
```
