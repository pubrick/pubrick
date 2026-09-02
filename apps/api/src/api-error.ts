import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { type ApiErrorCode, refusalBody } from "@pubrick/shared";

/**
 * The four ways this api refuses a request it has authenticated, each one
 * paired ONCE with the status code its body claims.
 *
 * The pairing is the entire reason these exist rather than
 * `new ConflictException(refusalBody(409, …))` at every throw site. Written out
 * by hand, `new NotFoundException(refusalBody(409, …))` compiles, answers HTTP
 * 404, and puts `"statusCode": 409` in the body — a lie told in the one place a
 * client goes to find out what happened. Here the status is written once per
 * helper and cannot be given a second value.
 *
 * The English sentence is required, not optional, and it is NOT dead weight
 * beside the code: it is what a developer reads in a network tab, what a
 * public-API consumer and the MCP server get, and what a web build older than
 * the code can still show the reader (`errorMessage`, apps/web/src/lib/api.ts).
 * Removing it would trade one audience's clarity for another's. What the code
 * adds is the fourth audience — the person reading the screen in Spanish,
 * Russian or Portuguese, who could never be served by an English sentence.
 */
export const badRequest = (code: ApiErrorCode, message: string | string[]) =>
  new BadRequestException(refusalBody(400, code, message));

export const notFound = (code: ApiErrorCode, message: string) =>
  new NotFoundException(refusalBody(404, code, message));

export const conflict = (code: ApiErrorCode, message: string) =>
  new ConflictException(refusalBody(409, code, message));

/**
 * A 403 that names itself.
 *
 * The only caller is `ActiveOrgGuard`'s "no active organization", and that is
 * the point rather than an oversight: until this existed the web identified
 * that refusal by matching `/no active organization/i` against the English
 * sentence in the body, and it branches on the answer to send the account to
 * onboarding. Every other 403 has its sentence replaced by the web's own
 * before a reader sees it, so none of them needs a code to be answered.
 */
export const forbidden = (code: ApiErrorCode, message: string) =>
  new ForbiddenException(refusalBody(403, code, message));
