import { createContext, useContext } from "react";

/**
 * The request's CSP nonce, provided by entry.server.tsx while it renders. The browser hides nonces from the DOM,
 * so on the client this is undefined and hydration keeps the attribute the server sent.
 */
export const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(): string | undefined {
  return useContext(NonceContext);
}
