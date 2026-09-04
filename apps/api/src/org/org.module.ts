import { Module } from "@nestjs/common";
import { InvitationsController } from "./invitations.controller";
import { InvitationsRepository } from "./invitations.repository";

/**
 * The organization's own routes, as opposed to the guard and decorators in this
 * folder that every other module borrows. Today that is one read: the
 * invitations waiting for the signed-in account.
 */
@Module({ controllers: [InvitationsController], providers: [InvitationsRepository] })
export class OrgModule {}
