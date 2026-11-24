A dialog is a modal panel of 560px in the center of the page.

It is the Radix dialog of the app, with the same class names.
The `modal-backdrop` layer behind it dims the page and makes it blurry.
When the dialog opens, the title gets the focus. When it closes, the focus goes back to the control that opened it.

The Escape key, the close button, and a click on the backdrop close the dialog.
The actions row has **Cancel** first and the primary action last.
Set `cancel={false}` to remove **Cancel**.
Use `inline` only in previews. It shows the panel in the page flow.

```jsx
<Dialog open={open} onOpenChange={setOpen} title="Report topic" description="Tell us what is wrong."
  actions={<button type="submit" className="gold">Send report</button>}>
  <label>Details<textarea rows={3} /></label>
</Dialog>
```
