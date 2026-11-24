The vote buttons are the **Like** and **Dislike** buttons of a topic, each with its count.

The part makes the `.votes` box.
In a topic panel that is wider than 500 pixels, the CSS puts the buttons in a vertical rail at the left of the topic.
The rail shows only the thumbs and the counts.
In a narrow panel, the buttons are in a row under the topic and show their labels.

A pressed button is gold and shows a filled thumb.
Click it again to remove the vote: `onReact` then gets 0.
Set `disabled` when the viewer cannot vote, for example before sign-in.

```jsx
<VoteButtons likes={142} dislikes={18} reaction={1} onReact={setReaction} />
```

Put the part in a `.topic-content` box to get the rail.
`TopicDetail` does this for you.
