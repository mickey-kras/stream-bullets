The overlay card shows the content of one content layer in OBS.

Sizes are design pixels at 1080p. A grid cell is 60 × 60 design pixels.
Put each card in an `OverlayLayer`. The layer scales the card to its cell and makes it smaller when it does not fit.

| Part | Content |
| --- | --- |
| `OverlayCard` | The topic spotlight, up next, the message banner, the community card, and the support banner (`kind`). |
| `OverlayPoll` | The poll on stream. The question is next to the QR code. The options use the full width. One status line is at the bottom. |
| `OverlayMash` | The Mash Battle on stream. It has the seconds ring or the winner, the bars, and the **Tap at** link. |
| `OverlayLayer` | A layer box at its cell in an `OverlayComposition`. |
| `OverlayQr` | The QR code of a card. Its size comes from the card. |

```jsx
<OverlayComposition>
  <OverlayLayer layer="poll" rect={{ x: 600, y: 0, w: 960, h: 480 }}>
    <OverlayPoll
      title="Should we explore more local AI on stream?"
      options={["Yes, more local AI", "A mix of both", "Stick to cloud tools"]}
      counts={[48, 31, 9]}
      secondsLeft={3720}
      qr="https://streambullets.com/@sunny?view=polls"
    />
  </OverlayLayer>
</OverlayComposition>
```

- The poll fills its cell. A cell that is higher than it is wide shows one option in each row.
- An option name of more than 12 characters gets a wide bar with one line.
- `counts` without a value hides the bars. Use this for a yes or no poll before the reveal.
- `backgroundOpacity` on the layer changes only the card fill. It does not change the text.
