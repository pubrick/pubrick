import { Module } from "@nestjs/common";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { auth } from "./auth";
import { BrandsModule } from "./brands/brands.module";
import { ChannelsModule } from "./channels/channels.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [AuthModule.forRoot({ auth }), HealthModule, BrandsModule, ChannelsModule],
})
export class AppModule {}
