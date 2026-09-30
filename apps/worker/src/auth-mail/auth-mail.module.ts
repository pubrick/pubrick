import { Module } from "@nestjs/common";
import { AuthMailRepository } from "./auth-mail.repository";
import { AuthMailService } from "./auth-mail.service";
@Module({ providers: [AuthMailRepository, AuthMailService], exports: [AuthMailService] })
export class AuthMailModule {}
