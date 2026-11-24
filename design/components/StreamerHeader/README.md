The streamer header is the header of a streamer page.

On the left are the StreamBullets mark, the picture of the streamer, and the name.
The tabs are icon links. The active tab is a gold plate.
On the right are the **Streamers** link, the language button, the notifications button, and the avatar.

The owner of the page also gets the **Overlay** tab. Set `own` for this.
On phones, the tabs move to a second row and show only icons.

Set `live` to show the live pill. A `ticker` text adds the on-air strip below the header.
Each link has an `href`. By default, the paths come from `handle`. Use `hrefFor` to change them.
`HeaderSuggestButton` is the gold action of the official StreamBullets page.

```jsx
<StreamerHeader name="Sunny" handle="sunny" preset={14} current="topics" />
<StreamerHeader name="Sunny" handle="sunny" current="polls" own live liveTitle="Can AI run my homelab?" ticker="Can AI run my homelab?" />
```
