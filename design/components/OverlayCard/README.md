The overlay card shows the content on air in OBS.

Sizes are design pixels at 1080p.
The kinds are the topic spotlight, up next, a message, and the community or support card.
The file also exports `OverlayPoll`.

```jsx
<OverlayCard kind="topic" title="Can AI run my homelab?" author="TechNomad" authorPreset={0} likes={142} />
<OverlayCard kind="next" title="Building a quiet streaming PC" when="Fri 8:00 PM" startsIn="in 45 min" />
<OverlayCard kind="message" messageStyle="hype" title="Raid incoming!" />
<OverlayPoll streamer="Sunny" title="Which game next?" options={["Hades II","Balatro"]} counts={[61,39]} countdown="1 min left" />
```
