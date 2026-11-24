The select is a combobox that only lets you select a value.

The app uses Radix Select.
It has a trigger and a list. A gold check marks the selected option.

```jsx
<Select label="Sort comments" defaultValue="top" options={[{value:"top",label:"Top"},{value:"new",label:"Newest"}]} />
<Select placeholder="Category" options={[{value:"tech",label:"Tech & setups",icon:"cat-tech"}]} />
```
