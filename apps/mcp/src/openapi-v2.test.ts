import { readFileSync } from "node:fs";
import {
  publicContentDetailV2Schema,
  publicContentListV2Schema,
  publicContentSummaryV2Schema,
  publicDraftCreateResultSchema,
  publicDraftCreateSchema,
  publicRunCreateResultSchema,
  publicRunCreateSchema,
  publicRunStatusSchema,
} from "@pubrick/shared";
import { expect, it } from "vitest";
import { z } from "zod";

it("keeps published v2 request/result contracts aligned with the frozen shared DTOs", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../../docs/openapi-v2.json", import.meta.url), "utf8"),
  );
  for (const [name, schema] of Object.entries({
    DraftCreate: publicDraftCreateSchema,
    DraftAccepted: publicDraftCreateResultSchema,
    RunCreate: publicRunCreateSchema,
    RunAccepted: publicRunCreateResultSchema,
    RunStatus: publicRunStatusSchema,
    ContentSummary: publicContentSummaryV2Schema,
    ContentDetail: publicContentDetailV2Schema,
    ContentList: publicContentListV2Schema,
  })) {
    const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    delete jsonSchema.$schema;
    expect(document.components.schemas[name], name).toEqual(jsonSchema);
  }
  expect(
    document.paths["/api/v2/content"].post.requestBody.content["application/json"].schema,
  ).toEqual({ $ref: "#/components/schemas/DraftCreate" });
  expect(
    document.paths["/api/v2/runs"].post.requestBody.content["application/json"].schema,
  ).toEqual({ $ref: "#/components/schemas/RunCreate" });
  expect(
    document.paths["/api/v2/runs/{id}"].get.responses[200].content["application/json"].schema,
  ).toEqual({ $ref: "#/components/schemas/RunStatus" });
  expect(document.paths["/api/v2/brands/{brandId}/publications"]).toBeUndefined();
});
