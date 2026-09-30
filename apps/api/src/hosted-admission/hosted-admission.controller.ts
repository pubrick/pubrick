import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { HostedAdmissionActor } from "@pubrick/db";
import { z } from "zod";
import { NotOrgScoped } from "../org/not-org-scoped.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { HostedAdmissionService } from "./hosted-admission.service";
import { HostedBrowserGuard } from "./hosted-browser.guard";

const id = z.string().min(1).max(128);
const org = z.object({ orgId: id }).strict();
const invitation = org.extend({ invitationId: id });
const member = org.extend({ memberId: id });
const create = z
  .object({ name: z.string().trim().min(1).max(100), slug: z.string().trim().min(1).max(100) })
  .strict();
const invite = org.extend({
  email: z.string().trim().max(320).email(),
  role: z.string().min(1).max(128),
  locale: z.enum(["en", "es", "ru", "pt"]),
  resendId: id.optional(),
});
const updateRole = member.extend({
  role: z.union([z.string().min(1).max(128), z.array(z.string().min(1).max(128)).min(1).max(5)]),
});
type SessionRequest = { session?: { user?: { id?: unknown }; session?: { id?: unknown } } };
function actor(request: SessionRequest): HostedAdmissionActor {
  const userId = request.session?.user?.id;
  const sessionId = request.session?.session?.id;
  if (typeof userId !== "string" || !userId || typeof sessionId !== "string" || !sessionId)
    throw new UnauthorizedException();
  return { userId, sessionId };
}

@Controller("hosted-admission")
@UseGuards(HostedBrowserGuard)
@NotOrgScoped(
  "Account-scoped workspace lifecycle: the repository revalidates body organization membership in its transaction, including pre-membership create and accept.",
)
export class HostedAdmissionController {
  constructor(@Inject(HostedAdmissionService) private readonly admission: HostedAdmissionService) {}
  @Post("create")
  @HttpCode(200)
  async create(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(create)) input: z.infer<typeof create>,
  ) {
    const result = await this.admission.create(actor(request), input);
    return { id: result.organizationId };
  }
  @Post("invite")
  @HttpCode(200)
  async invite(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(invite)) input: z.infer<typeof invite>,
  ) {
    const { orgId, ...data } = input;
    const result = await this.admission.invite(orgId, actor(request), data);
    return { id: result.invitationId, email: result.email, expiresAt: result.expiresAt };
  }
  @Post("accept")
  @HttpCode(200)
  accept(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(invitation)) input: z.infer<typeof invitation>,
  ) {
    return this.admission.accept(input.orgId, actor(request), input.invitationId);
  }
  @Post("cancel")
  @HttpCode(200)
  async cancel(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(invitation)) input: z.infer<typeof invitation>,
  ) {
    await this.admission.cancel(input.orgId, actor(request), input.invitationId);
    return { ok: true };
  }
  @Post("remove")
  @HttpCode(200)
  async remove(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(member)) input: z.infer<typeof member>,
  ) {
    await this.admission.remove(input.orgId, actor(request), input.memberId);
    return { ok: true };
  }
  @Post("update-role")
  @HttpCode(200)
  async updateRole(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(updateRole)) input: z.infer<typeof updateRole>,
  ) {
    await this.admission.updateRole(input.orgId, actor(request), input.memberId, input.role);
    return { ok: true };
  }
  @Post("leave")
  @HttpCode(200)
  async leave(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(org)) input: z.infer<typeof org>,
  ) {
    await this.admission.leave(input.orgId, actor(request));
    return { ok: true };
  }
  @Post("delete")
  @HttpCode(200)
  async delete(
    @Req() request: SessionRequest,
    @Body(new ZodValidationPipe(org)) input: z.infer<typeof org>,
  ) {
    await this.admission.delete(input.orgId, actor(request));
    return { ok: true };
  }
}
