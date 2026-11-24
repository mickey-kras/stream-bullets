The chat layer shows the merged Twitch, YouTube, and Kick chat in the OBS overlay.

Each message is one card in the system font at 26 design pixels.
A card has a platform icon, the user name, and the message.
The newest card has an accent border and a bar on the left.
The list grows from the bottom. The top 18% of the list fades.
A new row with `enter` moves up for 520 ms.

```jsx
<OverlayComposition>
  <OverlayLayer layer="chat" rect={{ x: 0, y: 240, w: 480, h: 840 }}>
    <ChatLayer
      rows={[
        { id: "1", platform: "twitch", name: "RustBucket", badges: ["Subscriber"], text: "Wasteland radio is live." },
        { id: "2", platform: "kick", name: "spam_bot_42", removed: true },
      ]}
      backgroundOpacity={100}
    />
  </OverlayLayer>
</OverlayComposition>
```

- Put the layer in a parent with a position and a size. `OverlayLayer` does this.
- `backgroundOpacity` changes only the card. It does not change the text. Below 50, the text gets a dark outline.
- `test` shows the **TEST** tag of a chat test at the top right of the layer.
- `fragments` holds text and emotes. An emote shows its name when its image does not load.
- Do not translate the platform names.
