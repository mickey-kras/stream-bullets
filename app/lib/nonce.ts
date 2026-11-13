import { createContext, useContext } from "react";

// CSP nonce from server rendering. Browsers hide DOM nonces; undefined preserves the server attribute during
// hydration.
export const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(): string | undefined {
  return useContext(NonceContext);
}
