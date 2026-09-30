import { createAuthMailer } from "./auth-mail";
import { identity } from "./env";
export const authMailer = identity.mail ? createAuthMailer() : null;
