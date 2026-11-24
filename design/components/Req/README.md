`Req` is the gold asterisk of a required field.

`RequiredNote` is the "* required" note at the top of a form.

```jsx
<RequiredNote />
<label>
  <span>Title<Req /></span>
  <input name="title" required />
</label>
```

- Screen readers do not read the asterisk. The `required` attribute of the field gives this information.
- Put the asterisk in the label text, after the name of the field.
