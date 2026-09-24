import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HTTP_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete"]);
const root = join(process.cwd(), "src");

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? controllerFiles(path)
      : entry.endsWith(".controller.ts")
        ? [path]
        : [];
  });
}

function decorators(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function calledDecorator(node: ts.Node, name: string): ts.CallExpression | undefined {
  for (const decorator of decorators(node)) {
    if (
      ts.isCallExpression(decorator.expression) &&
      ts.isIdentifier(decorator.expression.expression) &&
      decorator.expression.expression.text === name
    ) {
      return decorator.expression;
    }
  }
  return undefined;
}

function guardApplied(node: ts.Node): boolean {
  const decorator = calledDecorator(node, "UseGuards");
  return !!decorator?.arguments.some(
    (argument) => ts.isIdentifier(argument) && argument.text === "ActiveOrgGuard",
  );
}

type Scope = { kind: string; source?: string; key?: string };

function scopeOn(node: ts.Node): Scope | undefined {
  const call = calledDecorator(node, "BrandScope");
  const argument = call?.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  const properties = Object.fromEntries(
    argument.properties.flatMap((property) => {
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isIdentifier(property.name) ||
        !ts.isStringLiteralLike(property.initializer)
      ) {
        return [];
      }
      return [[property.name.text, property.initializer.text]];
    }),
  );
  if (!properties.kind) return undefined;
  return properties as Scope;
}

describe("brand scope on guarded routes", () => {
  it("declares an effective scope for every route and a matching path parameter", () => {
    const files = controllerFiles(root);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const problems: string[] = [];
    let guardedRoutes = 0;

    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (!ts.isClassDeclaration(statement) || !calledDecorator(statement, "Controller"))
          continue;
        const classGuarded = guardApplied(statement);
        const classScope = scopeOn(statement);
        const controllerPath = calledDecorator(statement, "Controller")?.arguments[0];
        const prefix =
          controllerPath && ts.isStringLiteralLike(controllerPath) ? controllerPath.text : "";
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const route = decorators(member)
            .map((decorator) => decorator.expression)
            .find(
              (expression): expression is ts.CallExpression =>
                ts.isCallExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                HTTP_VERBS.has(expression.expression.text),
            );
          if (!route || !(classGuarded || guardApplied(member))) continue;
          guardedRoutes++;
          const routePath = route.arguments[0];
          const suffix = routePath && ts.isStringLiteralLike(routePath) ? routePath.text : "";
          const name = `${prefix}/${suffix} ${member.name.getText(source)}`;
          const scope = scopeOn(member) ?? classScope;
          if (!scope) {
            problems.push(`${name}: missing @BrandScope`);
            continue;
          }
          if (
            (scope.kind === "brand" || scope.kind === "resource") &&
            (scope.source ?? (scope.kind === "resource" ? "param" : undefined)) === "param"
          ) {
            const key = scope.key ?? (scope.kind === "brand" ? "brandId" : "id");
            if (!`${prefix}/${suffix}`.split("/").includes(`:${key}`)) {
              problems.push(`${name}: scope expects :${key} but route has no such parameter`);
            }
          }
        }
      }
    }
    expect(guardedRoutes).toBeGreaterThanOrEqual(40);
    expect(problems).toEqual([]);
  });
});
