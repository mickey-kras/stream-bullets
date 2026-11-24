A button is the native `button` element with the classes of the app.

Use a button for each action in the interface.
Use one gold button in a view.

```jsx
<Button variant="gold" icon="plus">New poll</Button>
<Button icon="sign-in">Sign in</Button>
<Button variant="danger" icon="trash">Delete</Button>
<Button variant="small" icon="flag">Report</Button>
```

| Property | Values |
| --- | --- |
| `variant` | `default`, `gold`, `danger`, `small`, `text`, `link`, or `secondary` |
| `icon`, `iconEnd` | An icon name. The icon is 18px, or 16px for `small`. |
| `pressed` | Sets `aria-pressed`. |

- `default` has no class. The global `button` rule of the app gives it the dark gradient and the border.
- `small` gives the `small-button` class. `text` gives `text-button`. `link` gives `link-button`.
- The container can change the button. For example, `.landing-actions` gives the large landing buttons. `secondary` is the outlined button in that container.
- The text and the icons use Figtree. Some containers of the app set Oswald.
