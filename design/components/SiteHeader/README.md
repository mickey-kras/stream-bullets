The site header is the header of the pages that are not streamer pages.

The logo is on the left. It shows the mark on phones.
The navigation links are in the center. Phones do not show a link with `optional`.
On the right are the language button, the notifications button, and the avatar.

Without an account, the right side has **Sign in / Sign up** in place of the notifications button and the avatar.
When the links do not fit in one row, they move to a second row.

`HeaderLanguage` is the language button with the code of the language.
`SiteLogo` is the home link with the logo.

```jsx
<SiteHeader current="streamers"
  links={[{ id: "streamers", label: "Streamers", icon: "streamers", href: "/streamers" },
    { id: "your-page", label: "Your page", icon: "your-page", href: "/@sunny", optional: true }]}
  account={{ name: "Sunny", handle: "sunny", preset: 14 }} />
```
