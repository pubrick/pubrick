import { Module } from "@nestjs/common";
import { BrandsController } from "./brands.controller";
import { BrandsRepository } from "./brands.repository";

@Module({ controllers: [BrandsController], providers: [BrandsRepository] })
export class BrandsModule {}
