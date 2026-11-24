The poll card shows one poll in the Polls view.

It shows these items:

- A gold top line with the status and the time left.
- The question and the author.
- The option rows. Each row shows a bar, the count of votes, and the percentage.
- The total of votes and a hint.
- The **Discuss** button and the **Poll link** link.

The percentages always add up to 100.
The row of the vote of the viewer has a gold border and a check mark.

```jsx
<PollCard
  title="Should we explore more local AI on stream?"
  author="Sunny"
  options={["Yes, more local AI", "A mix of both", "Stick to cloud tools"]}
  counts={[48, 31, 9]}
  myVote={vote}
  onVote={setVote}
  countdown="1 h 2 min left"
  comments={1}
/>
```

Use `state` for the stages of a poll:

| `state` | Top line |
| --- | --- |
| `live` | **Voting live** and the time left, or **No time limit** |
| `closed` | **Voting closed** and **Time is up** |
| `revealed` | **Ended by host**, or **Results revealed** for a yes-or-no poll, and **Final** |

Set `kind="binary"` for a yes-or-no poll. The part then shows its 2 rows side by side.
Set `owner` to show the actions menu and the **End & reveal** button.

The file also exports these parts:

- `PollStatus`: the gold top line.
- `PollResults`: the option rows.
- `PollDiscussion`: the box under an open poll. It holds the **Report** button, the **Open discussion** button, and a `Discussion`.
