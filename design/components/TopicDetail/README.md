The topic detail panel shows one topic.

It has a teal gradient and a 1px border in `#607476`.
Put a `Discussion` in it as a child.

```jsx
<TopicDetail category="Tech & setups" categoryIcon="cat-tech" number="Topic 001" title="Can AI run my homelab?" author="Sunny"
  description="I'm curious how far we can take AI in a self-hosted setup…" likes={142} dislikes={18}>
  <Discussion count={24}>…</Discussion>
</TopicDetail>
```
