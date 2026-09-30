import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  BillingGrowthError,
  type HostedAdmissionActor,
  HostedAdmissionError,
  type HostedAdmissionLocale,
  HostedAdmissionRepository,
} from "@pubrick/db";
import { hostedInviteInputSchema } from "./hosted-admission.contracts";

/** The module binds the database-only billing and durable-mail ports at composition time. */
export class HostedAdmissionService {
  constructor(private readonly repository: HostedAdmissionRepository) {}
  private async invoke<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof BillingGrowthError) {
        const status =
          error.code === "subscription_required"
            ? 402
            : error.code === "resource_limit"
              ? 409
              : 503;
        throw new HttpException(
          { code: error.code, message: error.code, resource: error.resource },
          status,
        );
      }
      if (!(error instanceof HostedAdmissionError)) throw error;
      const response = { code: error.code, message: "Workspace action could not be completed." };
      if (error.code === "unauthenticated") throw new UnauthorizedException(response);
      if (error.code === "forbidden") throw new ForbiddenException(response);
      if (error.code === "not_found") throw new NotFoundException(response);
      throw new BadRequestException(response);
    }
  }
  create(actor: HostedAdmissionActor, input: { name: string; slug: string }) {
    return this.invoke(() => this.repository.create(actor, input));
  }
  invite(
    orgId: string,
    actor: HostedAdmissionActor,
    input: { email: string; role: string; locale: HostedAdmissionLocale; resendId?: string },
  ) {
    const parsed = hostedInviteInputSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException({
        code: "invalid_input",
        message: "Workspace action could not be completed.",
      });
    return this.invoke(() => this.repository.invite(orgId, actor, parsed.data));
  }
  accept(orgId: string, actor: HostedAdmissionActor, invitationId: string) {
    return this.invoke(() => this.repository.accept(orgId, actor, invitationId));
  }
  cancel(orgId: string, actor: HostedAdmissionActor, invitationId: string) {
    return this.invoke(() => this.repository.cancel(orgId, actor, invitationId));
  }
  remove(orgId: string, actor: HostedAdmissionActor, memberId: string) {
    return this.invoke(() => this.repository.remove(orgId, actor, memberId));
  }
  updateRole(
    orgId: string,
    actor: HostedAdmissionActor,
    memberId: string,
    role: string | readonly string[],
  ) {
    return this.invoke(() => this.repository.updateRole(orgId, actor, memberId, role));
  }
  leave(orgId: string, actor: HostedAdmissionActor) {
    return this.invoke(() => this.repository.leave(orgId, actor));
  }
  delete(orgId: string, actor: HostedAdmissionActor) {
    return this.invoke(() => this.repository.delete(orgId, actor));
  }
}
