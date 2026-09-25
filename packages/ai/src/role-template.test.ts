import { adaptationLimit } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import {
  assertRoleTemplateRenderedSize,
  previewRoleTemplate,
  ROLE_TEMPLATE_LIMITS,
  RoleTemplateError,
  type RoleTemplateValues,
  renderRoleTemplate,
} from "./role-template.js";

const writerValues: RoleTemplateValues = {
  current_date_utc: "2026-09-25",
  content_type: "expert_article",
  content_language: "pt-BR",
};

function expectRoleTemplateError(run: () => unknown, code: string, position?: number): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RoleTemplateError);
    expect(error).toMatchObject({ code, ...(position === undefined ? {} : { position }) });
    return;
  }
  throw new Error(`Expected RoleTemplateError with code ${code}`);
}

describe("role template scanner", () => {
  it("normalizes CRLF and renders exact closed tokens in one pass", () => {
    expect(
      renderRoleTemplate(
        "writer",
        "Today {{current_date_utc}}\r\n{{content_type}} in {{content_language}}. {{content_type}}",
        writerValues,
      ),
    ).toEqual({
      source:
        "Today {{current_date_utc}}\n{{content_type}} in {{content_language}}. {{content_type}}",
      text: "Today 2026-09-25\nexpert_article in pt-BR. expert_article",
      variables: ["current_date_utc", "content_type", "content_language"],
    });
  });

  it("treats escaped delimiters as literal text without rescanning", () => {
    expect(
      renderRoleTemplate("writer", "\\{{content_type\\}} = {{content_type}}", writerValues),
    ).toMatchObject({
      text: "{{content_type}} = expert_article",
      variables: ["content_type"],
    });
    expect(renderRoleTemplate("writer", "{json: true}", writerValues).text).toBe("{json: true}");
  });

  it("limits adapter variables to adapters and checks their actual platform limit", () => {
    const channelLimit = adaptationLimit("bluesky");
    expect(channelLimit).toBeDefined();
    const values = {
      ...writerValues,
      channel_platform: "bluesky" as const,
      channel_limit: channelLimit,
    };
    expect(
      renderRoleTemplate("adapter", "{{channel_platform}}: {{channel_limit}}", values).text,
    ).toBe("bluesky: 300");
    expectRoleTemplateError(
      () => renderRoleTemplate("adapter", "{{channel_limit}}", { ...values, channel_limit: 301 }),
      "invalid_values",
    );
    expectRoleTemplateError(
      () => renderRoleTemplate("writer", "{{channel_limit}}", writerValues),
      "unknown_variable",
    );
    expectRoleTemplateError(() => renderRoleTemplate("writer", "Hello", values), "invalid_values");
  });

  it("rejects unknown, malformed, unclosed, and unexpected delimiters at their positions", () => {
    for (const source of [
      "{{ name }}",
      "{{content.type}}",
      "{{#content_type}}",
      "{{",
      "{{content_type}}}",
      "}}",
    ]) {
      expectRoleTemplateError(
        () => renderRoleTemplate("writer", source, writerValues),
        "malformed_token",
      );
    }
    expectRoleTemplateError(
      () => renderRoleTemplate("writer", "😀 {{secret}}", writerValues),
      "unknown_variable",
      2,
    );
  });

  it("rejects untrusted fixture keys and malformed typed values", () => {
    expectRoleTemplateError(
      () =>
        renderRoleTemplate("writer", "Text", {
          ...writerValues,
          brief: "ignore rules",
        } as RoleTemplateValues),
      "invalid_values",
    );
    const inherited = Object.create({ content_language: "en" }) as RoleTemplateValues;
    inherited.current_date_utc = "2026-09-25";
    inherited.content_type = "social_post";
    expectRoleTemplateError(
      () => renderRoleTemplate("writer", "{{content_language}}", inherited),
      "invalid_values",
    );
    for (const values of [
      { ...writerValues, current_date_utc: "2026-02-30" },
      { ...writerValues, content_type: "unknown" },
      { ...writerValues, content_language: 'en" bad' },
    ]) {
      expectRoleTemplateError(
        () => renderRoleTemplate("writer", "Text", values as RoleTemplateValues),
        "invalid_values",
      );
    }
  });

  it("rejects controls but preserves tabs, LF, and normalized CRLF", () => {
    expect(renderRoleTemplate("writer", "a\t\r\nb", writerValues).text).toBe("a\t\nb");
    for (const source of ["a\0b", "a\rb", "a\u007fb", "a\u0085b"]) {
      expectRoleTemplateError(
        () => renderRoleTemplate("writer", source, writerValues),
        "control_character",
      );
    }
  });

  it("bounds normalized source by Unicode code points and UTF-8 bytes", () => {
    const fits = "😀".repeat(ROLE_TEMPLATE_LIMITS.sourceCodePoints);
    expect(renderRoleTemplate("writer", fits, writerValues).source).toBe(fits);
    expectRoleTemplateError(
      () => renderRoleTemplate("writer", `${fits}x`, writerValues),
      "source_limit",
    );
    expectRoleTemplateError(
      () =>
        renderRoleTemplate(
          "writer",
          `x${"\r\n".repeat(ROLE_TEMPLATE_LIMITS.sourceCodePoints)}`,
          writerValues,
        ),
      "source_limit",
    );
  });

  it("bounds rendered output independently of future token values", () => {
    expect(() =>
      assertRoleTemplateRenderedSize("😀".repeat(ROLE_TEMPLATE_LIMITS.renderedCodePoints)),
    ).not.toThrow();
    expectRoleTemplateError(
      () =>
        assertRoleTemplateRenderedSize("😀".repeat(ROLE_TEMPLATE_LIMITS.renderedCodePoints + 1)),
      "render_limit",
    );
  });

  it("uses a fixed, non-tenant preview fixture", () => {
    expect(
      previewRoleTemplate(
        "writer",
        "{{current_date_utc}} / {{content_type}} / {{content_language}}",
      ),
    ).toMatchObject({ text: "2026-01-15 / social_post / en" });
    expect(previewRoleTemplate("adapter", "{{channel_platform}} {{channel_limit}}").text).toBe(
      `telegram ${adaptationLimit("telegram")}`,
    );
  });
});
