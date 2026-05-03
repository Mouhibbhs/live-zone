import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

export function requireAuth(request: CallableRequest<unknown>) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  return request.auth;
}

export function requireAdmin(request: CallableRequest<unknown>) {
  const auth = requireAuth(request);

  if (auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  return auth;
}

