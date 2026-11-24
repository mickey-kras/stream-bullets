import React from "react";
import { Icon } from "../core/Icon.jsx";

export function BackLink({ children = "Back", href = "#", onClick }) {
  return <a className="sb-back" href={href} onClick={onClick}><Icon name="chevron-left" size={18} />{children}</a>;
}
