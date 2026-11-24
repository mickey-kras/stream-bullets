The discussion block holds the comments of a topic.

It has a head with the sort control, the comment rows, and a composer with a gold Post button.
Dashed lines divide the comments.

```jsx
<Discussion count={24}>
  <Comment name="TechNomad" subtitle="Community member" preset={0} likes={27}>I've been running a local model on a mini PC…</Comment>
  <Composer />
</Discussion>
```

The file also exports `Comment` and `Composer`.
