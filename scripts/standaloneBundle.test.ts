import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Story ST1, slice 1: the app bundles no BMAD (st_no_bmad_bundle). ade brings
 * the method; the installer carries a terminal.
 */
const ROOT = resolve(__dirname, "..");
const conf = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const resources: Record<string, string> | string[] = conf.bundle?.resources ?? {};
const entries = Array.isArray(resources) ? resources : [...Object.keys(resources), ...Object.values(resources)];

describe("st_no_bmad_bundle: the installer carries no BMAD", () => {
  it("tauri.conf.json bundles no bmad, bmad-v6, ade-runtime.mjs or personas resource", () => {
    for (const entry of entries) {
      expect(entry, entry).not.toMatch(/bmad|ade-runtime\.mjs|personas/i);
    }
  });

  it("the resource folders and the runtime are gone", () => {
    for (const gone of ["bmad", "bmad-v6", "ade-runtime.mjs", "personas"]) {
      expect(existsSync(resolve(ROOT, "src-tauri/resources", gone)), gone).toBe(false);
    }
    expect(existsSync(resolve(ROOT, "vite.runtime.config.ts"))).toBe(false);
  });

  it("the build makes no BMAD runtime", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/runtime|bmad/i);
  });
});
