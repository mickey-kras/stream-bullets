The account menu is a panel that opens from the avatar in the header.

The part has the notifications button, the avatar button, and the panel.
The panel has an identity row, the account links, and **Sign out**.
The current link has a gold bar on its inner edge.
The Escape key, a click outside, or a click on a link closes the panel.

`accountMenuItems` gives the links in the order of the app.
A streamer gets the links of the own page first. The streamer header adds **Streamers**.
`NotificationLink` is the notifications button. `SignInButton` is the button for readers without an account.
Put the menu in a header, because the app CSS places the panel below the header.

```jsx
<SiteHeader account={{ name: "Sunny", handle: "sunny", preset: 14, unread: 3, defaultOpen: true }} />
```
