The site footer is the row of links at the bottom of each page.

The links are **Streamers**, **Privacy**, **Terms**, **Contact**, **Report content**, **Accessibility**, **Suggest an improvement**, **AI agents**, and the language.
On phones, a short row has icons and a **More** button. **More** opens a sheet with the other links.

The paths come from `app/lib/shell.ts`. Use `paths` to change them.
**Contact** is a button. It calls `onContact`.

The app CSS styles the footer as a child of `body`.
In a preview, render it into `body` with a portal.

```jsx
ReactDOM.createPortal(<SiteFooter current="streamers" onContact={openContact} />, document.body)
```
