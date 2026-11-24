A topic row is one row in the topic list of the topic board.

It shows the category icon, the title, the counts of likes, dislikes, and comments, and a chevron.
The title wraps to two lines.
In a list that is narrower than 480 pixels, the counts move under the title.
A selected row has a gold fill.

The row is a toggle button. The `selected` prop sets `aria-pressed`.
Screen readers read the counts as one phrase, for example "142 likes, 18 dislikes, 2 comments".

```jsx
<section className="browse" aria-label="Browse topics">
  <section id="topics" aria-label="Topics">
    <TopicRow id="1" title="Can AI run my homelab?" category="Tech & setups" likes={142} dislikes={18} comments={2} selected />
  </section>
</section>
```

Put the rows in a `.browse` box. The CSS uses the width of this box to set the layout of the rows.
