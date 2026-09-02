import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import { refusalBody } from "@pubrick/shared";
import type { ZodType } from "zod";

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  /**
   * ONE code for the whole boundary, and the array of field-qualified issues
   * exactly as it was.
   *
   * The two halves have two different audiences, and this is the split that lets
   * each keep what it needs. `message` stays `["scheduledAt: scheduledAt must be
   * in the future"]` — the path zod knows the field by, joined to zod's own
   * sentence — because that is what a developer reads in a network tab and what
   * an API consumer parses. `code` is `invalid_request` because there is nothing
   * finer a browser could be given: this pipe refuses a WHOLE BODY and cannot
   * say which of its issues is the one that mattered, and a code per field per
   * rule would be an open set that drifts the moment a schema changes.
   *
   * Which leaves the real question — a user must never read a wire field name —
   * answered by reachability rather than by formatting. Reformatting the join
   * would still leave zod's English ("String must contain at most 4096
   * character(s)"), untranslated, in a product that ships in four languages, so
   * it fixes nothing for the reader. Instead: the one validation refusal a
   * person can actually provoke through the shipped UI — a schedule time in the
   * past, which no date picker can prevent because the clock keeps moving
   * between pick and submit — moved OUT of the DTO and into
   * `ContentRepository.approve`, where it is a domain refusal with a code of its
   * own (`schedule_in_past`). Everything else this pipe can refuse is either
   * unreachable from the UI (the textareas enforce `MAX_BODY_LENGTH` and
   * `MAX_BRIEF_LENGTH` with `maxLength`, the selects are built from the enums)
   * or a hand-built request from someone who wants the array, and both are
   * served by one honest sentence that names no field at all.
   */
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        refusalBody(
          400,
          "invalid_request",
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        ),
      );
    }
    return result.data;
  }
}
