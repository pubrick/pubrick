import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarRepository } from "./calendar.repository";

@Module({ controllers: [CalendarController], providers: [CalendarRepository] })
export class CalendarModule {}
