import { Module } from "@nestjs/common";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { auth } from "./auth";
import { BrandsModule } from "./brands/brands.module";
import { ChannelsModule } from "./channels/channels.module";
import { ContentModule } from "./content/content.module";
import { HealthModule } from "./health/health.module";
import { QueueModule } from "./queue/queue.module";

@Module({
  imports: [
    AuthModule.forRoot({ auth }),
    QueueModule,
    HealthModule,
    BrandsModule,
    ChannelsModule,
    ContentModule,
  ],
})
export class AppModule {}
