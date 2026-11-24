A toast is a short message at the bottom center of the page.

It is the Radix toast of the app.
Show one toast at a time.
Write a short message in the past tense, and end it with a period.
A toast stays for 5 seconds plus 60 milliseconds for each character.
A toast with an action, such as **Undo**, stays for 10 seconds or more.
An error toast is dark red, and screen readers announce it at once.

Set `floating` to show the toast at the bottom center of the window, as in the app.
Without `floating`, the toast stays in the page flow and does not close.

```jsx
<Toast floating message="Page link copied." />
<Toast message="Topic deleted." action={{ label: "Undo", onClick: undo }} />
<Toast tone="error" message="Could not save. Try again." />
```
