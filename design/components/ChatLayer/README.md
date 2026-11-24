The chat layer shows the merged chat in the OBS overlay.

Each message is one card with the system font at 26px.
A card has a mustard platform icon, the name, and ivory text.
The newest card has a gold border and a 3px gold bar on the left.

```jsx
<div style={{ position: "relative", width: 600, height: 840 }}>
  <ChatLayer rows={[{ platform: "twitch", name: "PixelLuna", text: "that build is so clean" }, { platform: "youtube", name: "TechNomad", badges: ["MOD"], text: "!jump" }]} />
</div>
```

- `backgroundOpacity` changes the card only. It does not change the text.
- Do not translate the platform names.
