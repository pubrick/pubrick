import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarRepository } from "./calendar.repository";
import { MemorableDatesController } from "./memorable-dates.controller";
import { MemorableDatesRepository } from "./memorable-dates.repository";

@Module({
  controllers: [CalendarController, MemorableDatesController],
  providers: [CalendarRepository, MemorableDatesRepository],
})
export class CalendarModule {}
