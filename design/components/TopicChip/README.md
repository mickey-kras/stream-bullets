A topic chip is a round label that shows a topic linked to a stream.

The schedule shows the chips under a stream.
A chip with `href` is a link to the topic.

In the stream form, each chip is a toggle button.
Give `pressed` and `onClick` for this type.
A pressed chip has a gold border and gold text.

Put the chips in `TopicChips`. This row wraps on wide screens.
On phones, the row scrolls to the side.

```jsx
<TopicChips>
  <TopicChip icon="cat-tech" href="?view=topics&entry=1">Can AI run my homelab?</TopicChip>
</TopicChips>

<TopicChips as="fieldset" label="Linked topics">
  <TopicChip icon="cat-gaming" pressed={on} onClick={toggle}>Which game deserves a second chance?</TopicChip>
</TopicChips>
```
