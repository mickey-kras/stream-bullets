An empty state is a panel with a dashed border.

It shows when a list or a view has no items.
It has a gold icon of 40px, a gold title, and a muted line of text.
It can have one action below the text.

```jsx
<EmptyState icon="polls" title="No polls yet" action={<button type="button" className="gold">Create a poll</button>}>
  Start a poll and let the community vote.
</EmptyState>
```
