import { shell } from "./shell";
export function GET(): Response { return new Response(shell, { headers: { "Content-Type": "text/html; charset=utf-8" } }); }
