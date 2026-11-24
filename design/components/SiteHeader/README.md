The site header is the header of the pages that are not streamer pages.

The logo is on the left. The navigation links use Figtree at weight 600 with icons of 18px.
The avatar, or Sign in, is on the right.
Below the header is a 1px line in `#b29b57` at 50% opacity.
Each link has an `href`. The logo goes to `homeHref`, which is `/` by default.

```jsx
<SiteHeader current="streamers" links={[{id:"streamers",label:"Streamers",icon:"streamers",href:"/streamers"},{id:"your-page",label:"Your page",icon:"your-page",href:"/@sunny"}]} />
```
