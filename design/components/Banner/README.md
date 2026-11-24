A banner is a moderation note at the top of a streamer page.

It shows when an administrator freezes or suspends a page.
Nobody can post or vote on a frozen page. The public cannot see a suspended page.
The text and the controls change with `role`:

- `viewer`: a note that the page is frozen.
- `owner`: the reason and the **Appeal / contact us** button.
- `admin`: the **Unfreeze** button and the **Open moderation** link.

`OwnerNotice` is the short note of the owner in the account menu.

```jsx
<Banner />
<Banner role="owner" onAppeal={openContact} />
<Banner tone="suspended" role="admin" moderationHref="/admin?view=pages" />
```
