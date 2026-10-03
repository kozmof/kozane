import { afterEach, describe, expect, it } from "vitest";
import { isSsgBuild, ssgIncludesScopedFiles } from "./ssg";

const originalSsg = process.env.KOZANE_SSG;
const originalScoped = process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("KOZANE_SSG", originalSsg);
  restore("KOZANE_SSG_INCLUDE_SCOPED_FILES", originalScoped);
});

describe("isSsgBuild", () => {
  it("is true only for the exact value the CLI sets", () => {
    process.env.KOZANE_SSG = "1";
    expect(isSsgBuild()).toBe(true);
  });

  // The point of the function: nine call sites compared against the literal themselves, and
  // anything other than "1" means "not an export" — which for a `prerender` export is the
  // answer that silently ships the wrong build.
  it("is false for anything else, including the truthy spellings of yes", () => {
    for (const value of ["0", "", "true", "yes", "01", " 1"]) {
      process.env.KOZANE_SSG = value;
      expect(isSsgBuild()).toBe(false);
    }
    delete process.env.KOZANE_SSG;
    expect(isSsgBuild()).toBe(false);
  });

  // `kozane net ssg generate` passes "" rather than unsetting it when the flag is off; the
  // check has to read that as false, not as "present".
  it("reads the empty string the CLI passes as off", () => {
    process.env.KOZANE_SSG = "";
    expect(isSsgBuild()).toBe(false);
  });

  it("is read on each call, so a `prerender` export cannot bind a stale value", () => {
    delete process.env.KOZANE_SSG;
    expect(isSsgBuild()).toBe(false);
    process.env.KOZANE_SSG = "1";
    expect(isSsgBuild()).toBe(true);
  });
});

describe("ssgIncludesScopedFiles", () => {
  it("is true only for the exact value --include-scoped-files sets", () => {
    process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES = "1";
    expect(ssgIncludesScopedFiles()).toBe(true);
  });

  it("is false when the flag was off, however that was spelled", () => {
    for (const value of ["", "0", "true"]) {
      process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES = value;
      expect(ssgIncludesScopedFiles()).toBe(false);
    }
    delete process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES;
    expect(ssgIncludesScopedFiles()).toBe(false);
  });

  // Independent of the build flag: the three page loads ask both questions separately, and
  // one answering for the other is how a live board would start reading page data for files.
  it("says nothing about whether this is an export", () => {
    process.env.KOZANE_SSG = "1";
    delete process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES;
    expect(ssgIncludesScopedFiles()).toBe(false);
  });
});
