An avatar is the round picture of a person or a streamer page.

It shows an uploaded photo or one of the 18 illustrated preset portraits.
It never shows initials.
If there is no photo and no preset, it shows the Space explorer (preset 14).

```jsx
<Avatar preset={0} />
<Avatar preset={9} size={32} />
<Avatar url="/me.jpg" size={48} />
<StreamerLogo logo={null} avatar={null} ownerAvatarPreset={14} className="brand-avatar" />
```

- The markup is the `Picture` of the app: a `span.user-avatar.portrait` for a preset, or an `img.user-avatar` for a photo.
- The avatar is 42px with a gold border. The containers of the app set other sizes, for example `.brand .brand-avatar`.
- `size` 48, 32, or 20 adds the `avatar-48`, `avatar-32`, or `avatar-20` class. Other values set the width and the height on the element.
- The avatar is decorative. Put the name in the text next to it.
- `AVATAR_ORDER` gives the order of the avatar picker. `AVATAR_NAMES` gives the English names.
