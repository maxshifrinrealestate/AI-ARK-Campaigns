import { isAcceptable, MvResult, verifyEmailViaMv } from "../integrations/millionverifier.js";

export type VerifyEmailResult = MvResult & { accepted: boolean };

export async function verifyEmail(email: string): Promise<VerifyEmailResult> {
  const result = await verifyEmailViaMv(email);
  return { ...result, accepted: isAcceptable(result.status) };
}
