import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarRepository } from "./calendar.repository";
import { EditorialPlaceholdersController } from "./editorial-placeholders.controller";
import { EditorialPlaceholdersRepository } from "./editorial-placeholders.repository";
import { EditorialPlansController } from "./editorial-plans.controller";
import { EditorialPlansRepository } from "./editorial-plans.repository";
import { MemorableDatesController } from "./memorable-dates.controller";
import { MemorableDatesRepository } from "./memorable-dates.repository";

@Module({
  controllers: [
    EditorialPlansController,
    CalendarController,
    MemorableDatesController,
    EditorialPlaceholdersController,
  ],
  providers: [
    EditorialPlansRepository,
    CalendarRepository,
    MemorableDatesRepository,
    EditorialPlaceholdersRepository,
  ],
})
export class CalendarModule {}
