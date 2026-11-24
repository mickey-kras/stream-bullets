The logo part shows the StreamBullets wordmark or the antenna icon from `assets/Logos`.

```jsx
<Logo />
<Logo kind="full" className="landing-logo" />
<Logo kind="icon" height={32} />
```

| `kind` | Result |
| --- | --- |
| `site` | The home link of the site header. It shows the wordmark. On phones, it shows the icon. |
| `full` | The wordmark image, 305×84. |
| `icon` | The icon image, 128×136. |

- The images have an empty `alt`. For `site`, `label` gives the name of the link. The default is "Home".
- The containers of the app set the image size. Use `height` only outside these containers.
