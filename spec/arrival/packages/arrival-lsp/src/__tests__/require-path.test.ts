import { describe, expect, it } from "vitest";

import { lookupProjectFile, projectDirname, projectJoin, resolveRequireProjectKey } from "../require-path.js";

const FILES = {
  "inhuman-custdev/config.scm": '(define config/product "x")',
  "inhuman-custdev/best-tagline.scm": '(require "config.scm")',
  "inhuman-taglines/config.scm": '(define config/product "y")',
  "inhuman-taglines/main.scm": '(require "config.scm")',
  "inhuman-gepa/gepa.scm": '(require "metric.scm")',
  "inhuman-gepa/metric.scm": "(define metric 1)",
};

describe("resolveRequireProjectKey", () => {
  it("exact project-relative key", () => {
    expect(resolveRequireProjectKey(FILES, "inhuman-custdev/config.scm")).toBe("inhuman-custdev/config.scm");
  });

  it("strips ./ on exact key", () => {
    expect(resolveRequireProjectKey(FILES, "./inhuman-gepa/metric.scm")).toBe("inhuman-gepa/metric.scm");
  });

  it("relative to open buffer directory", () => {
    expect(
      resolveRequireProjectKey(FILES, "config.scm", {
        fromFile: "inhuman-custdev/best-tagline.scm",
      }),
    ).toBe("inhuman-custdev/config.scm");
    expect(
      resolveRequireProjectKey(FILES, "./config.scm", {
        fromFile: "inhuman-taglines/main.scm",
      }),
    ).toBe("inhuman-taglines/config.scm");
  });

  it("unique basename without fromFile (metric.scm only once)", () => {
    expect(resolveRequireProjectKey(FILES, "metric.scm")).toBe("inhuman-gepa/metric.scm");
  });

  it("ambiguous basename without fromFile → null", () => {
    expect(resolveRequireProjectKey(FILES, "config.scm")).toBeNull();
  });

  it("lookup returns source text", () => {
    expect(lookupProjectFile(FILES, "config.scm", { fromFile: "inhuman-custdev/best-tagline.scm" })).toContain(
      "config/product",
    );
  });
});

describe("projectJoin / projectDirname", () => {
  it("dirname of nested path", () => {
    expect(projectDirname("a/b/c.scm")).toBe("a/b");
    expect(projectDirname("c.scm")).toBe("");
  });

  it("join stays under project", () => {
    expect(projectJoin("inhuman-custdev", "config.scm")).toBe("inhuman-custdev/config.scm");
    expect(projectJoin("inhuman-custdev", "./config.scm")).toBe("inhuman-custdev/config.scm");
  });
});
