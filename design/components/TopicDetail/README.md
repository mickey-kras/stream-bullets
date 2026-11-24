The topic detail is the right panel of the topic board, and it shows the selected topic.

It shows these items:

- The category plate and the **Topic link** link.
- The title and the author.
- The description.
- The **Open discussion** button.
- The vote buttons. In a wide panel, they are in a rail at the left.
- The **Report** button.

Put a `Discussion` in it as a child. The discussion then shows under the topic, in the same panel.

```jsx
<TopicDetail
  category="Tech & setups"
  title="Can AI run my homelab?"
  author="Sunny"
  description="I'm curious how far we can actually take AI in a self-hosted setup…"
  likes={142}
  dislikes={18}
  reaction={reaction}
  onReact={setReaction}
>
  <Discussion>…</Discussion>
</TopicDetail>
```

Set `signedIn={false}` for a guest. The part then disables the vote buttons and shows a sign-in hint in place of the **Report** button.
Set `reported` to show the **Reported** label in place of the **Report** button.
On phones, the **All topics** button goes back to the list.
