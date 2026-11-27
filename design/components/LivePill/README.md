The live pill is a red badge next to the streamer name. On phones, it is below the name.

It shows while an event of the schedule is in progress.
It links to the schedule. Give the event title in `title` for screen readers.
Its color is `status-live`, so it changes in the color-blind themes.

`OnAirTicker` is the strip below the header at the same time.
It shows the title of the event.

```jsx
<LivePill title="Can AI run my homelab?" href="/@sunny?view=schedule" />
<OnAirTicker title="Can AI run my homelab?" href="/@sunny?view=schedule" />
```
