import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { appContext } from "../env";
import { legal, type LegalDetails } from "../legal";

const detailsSchema = z
  .object({
    operatorName: z.string().trim().min(1).max(200),
    operatorCountry: z.string().trim().min(1).max(100),
    policyEffectiveDate: z.iso.date(),
  })
  .strict();

// Only approved public fields leave the server. Never log the secret or parse errors.
export function legalLoader({ context }: LoaderFunctionArgs): LegalDetails {
  const value = context.get(appContext).env.LEGAL_DETAILS;
  if (value === undefined) return { ...legal };
  try {
    return { ...legal, ...detailsSchema.parse(JSON.parse(value)) };
  } catch {
    throw new Response("Legal details are not configured correctly.", { status: 503 });
  }
}
