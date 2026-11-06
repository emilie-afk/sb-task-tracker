// Sign-out. Success is reported only after the server confirms it revoked the session; any network, server or
// database failure leaves the session state untouched and is reported as unconfirmed so the user can retry.
import { api, endClientSession } from "./api";

export const SIGN_OUT_FAILED = "Sign-out could not be confirmed. Please try again.";
export type SignOutResult = { confirmed: true } | { confirmed: false; message: string };

export async function signOut(): Promise<SignOutResult> {
  try {
    const r = await api<{ ok?: boolean }>("/auth/logout", { method: "POST", json: {} });
    if (!r || r.ok !== true) return { confirmed: false, message: SIGN_OUT_FAILED };
  } catch {
    return { confirmed: false, message: SIGN_OUT_FAILED };
  }
  endClientSession();
  return { confirmed: true };
}
